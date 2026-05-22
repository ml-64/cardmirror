#!/usr/bin/env node
/**
 * Verbatimize-recognition experiment generator.
 *
 * Takes a CardMirror-exported .docx and emits five test variants
 * to a sibling output directory. You open each in Word with
 * Verbatim installed and report which ones activate the Debate
 * ribbon. The result tells us the minimum addition to our export
 * pipeline that makes a CardMirror docx Verbatim-recognized.
 *
 *   Usage: node bin/experiment-verbatimize.mjs path/to/base.docx
 *
 * Output: five files next to base.docx:
 *   base.docx                              (control — untouched)
 *   base.v1-control.docx                   (= base, renamed for clarity)
 *   base.v2-version-match.docx             (VerbatimVersion="6.0.0")
 *   base.v3-version-lower.docx             (VerbatimVersion="1.0")
 *   base.v4-version-sentinel.docx          (VerbatimVersion="cardmirror")
 *   base.v5-full-docvar-set.docx           (all five docVars from
 *                                          Debate.dotm's settings.xml)
 *
 * All five variants add or modify only `word/settings.xml` (and the
 * settings.xml content-type + document.xml.rels relationship if
 * those don't already exist in the base). Everything else — the
 * style block, the document body, comments, media — is left exactly
 * as CardMirror exported it.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, basename, extname, join } from 'node:path';
import JSZip from 'jszip';

const [, , inputPath] = process.argv;
if (!inputPath) {
  console.error('Usage: node bin/experiment-verbatimize.mjs path/to/base.docx');
  process.exit(2);
}
if (!existsSync(inputPath)) {
  console.error(`Not found: ${inputPath}`);
  process.exit(2);
}

const baseBytes = readFileSync(inputPath);
const baseZip = await JSZip.loadAsync(baseBytes);
const outDir = dirname(inputPath);
const baseStem = basename(inputPath, extname(inputPath));

const SETTINGS_PART = 'word/settings.xml';
const CONTENT_TYPES_PART = '[Content_Types].xml';
const DOCUMENT_RELS_PART = 'word/_rels/document.xml.rels';

const SETTINGS_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml';
const SETTINGS_REL_TYPE =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings';

/** Build a complete word/settings.xml from a docVars map. */
function buildSettingsXml(docVars) {
  const docVarLines = Object.entries(docVars)
    .map(([name, val]) => `    <w:docVar w:name="${name}" w:val="${val}"/>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:docVars>
${docVarLines}
  </w:docVars>
</w:settings>
`;
}

/** Inject a single Override into [Content_Types].xml if not present. */
function injectContentType(xml, partName, contentType) {
  if (xml.includes(`PartName="${partName}"`)) return xml;
  const override = `<Override PartName="${partName}" ContentType="${contentType}"/>`;
  return xml.replace('</Types>', `${override}</Types>`);
}

/** Inject a relationship into document.xml.rels if not present. */
function injectRelationship(xml, type, target) {
  if (xml.includes(`Target="${target}"`)) return xml;
  // Pick a fresh rId — scan existing IDs and use one past the max.
  const ids = [...xml.matchAll(/Id="rId(\d+)"/g)].map((m) => parseInt(m[1], 10));
  const next = (ids.length === 0 ? 0 : Math.max(...ids)) + 1;
  const rel = `<Relationship Id="rId${next}" Type="${type}" Target="${target}"/>`;
  return xml.replace('</Relationships>', `${rel}</Relationships>`);
}

/** Produce a variant: clone the base zip, write a new settings.xml,
 *  and ensure the content-type + relationship are declared. */
async function makeVariant(label, docVars) {
  const zip = await JSZip.loadAsync(baseBytes);
  zip.file(SETTINGS_PART, buildSettingsXml(docVars));

  const ct = await zip.file(CONTENT_TYPES_PART).async('string');
  zip.file(
    CONTENT_TYPES_PART,
    injectContentType(ct, `/${SETTINGS_PART}`, SETTINGS_CONTENT_TYPE),
  );

  const rels = await zip.file(DOCUMENT_RELS_PART).async('string');
  zip.file(
    DOCUMENT_RELS_PART,
    injectRelationship(rels, SETTINGS_REL_TYPE, 'settings.xml'),
  );

  // `compression: 'DEFLATE'` is required — JSZip defaults to STORE
  // (no compression) on generateAsync, so re-serializing a docx
  // round-trips a ~2 MB original up to ~20 MB. The standard docx
  // format uses DEFLATE on every part; match that.
  const out = await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });
  const outPath = join(outDir, `${baseStem}.${label}.docx`);
  writeFileSync(outPath, out);
  return outPath;
}

/** Build a settings.xml that adds an `<w:attachedTemplate>` (and
 *  optionally docVars). The relationship for the template is
 *  injected separately into document.xml.rels. */
function buildSettingsWithAttachedTemplate(docVars, attachedTemplateRelId) {
  const docVarBlock = docVars
    ? `  <w:docVars>
${Object.entries(docVars)
  .map(([n, v]) => `    <w:docVar w:name="${n}" w:val="${v}"/>`)
  .join('\n')}
  </w:docVars>
`
    : '';
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <w:attachedTemplate r:id="${attachedTemplateRelId}"/>
${docVarBlock}</w:settings>
`;
}

/** Produce a variant with `<w:attachedTemplate>` set. `templatePath`
 *  is whatever string we want Word to store as the attached
 *  template — typically "Debate.dotm" (bare; relies on Word's
 *  template-search path) or a full path like
 *  "file:///C:/Users/.../Debate.dotm". `TargetMode="External"` is
 *  what tells Word this is a file-system path rather than an
 *  in-package part reference. */
async function makeTemplateVariant(label, templatePath, extraDocVars = null) {
  const zip = await JSZip.loadAsync(baseBytes);

  // Pick a relationship ID not already used in document.xml.rels.
  const rels = await zip.file(DOCUMENT_RELS_PART).async('string');
  const ids = [...rels.matchAll(/Id="rId(\d+)"/g)].map((m) => parseInt(m[1], 10));
  const next = (ids.length === 0 ? 0 : Math.max(...ids)) + 1;
  const relId = `rId${next}`;

  zip.file(
    SETTINGS_PART,
    buildSettingsWithAttachedTemplate(extraDocVars, relId),
  );

  // Inject the attached-template relationship. Use TargetMode=External
  // so Word interprets the Target as a file-system path.
  const updatedRels = rels.replace(
    '</Relationships>',
    `<Relationship Id="${relId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/attachedTemplate" Target="${templatePath}" TargetMode="External"/></Relationships>`,
  );
  zip.file(DOCUMENT_RELS_PART, updatedRels);

  // Settings.xml content-type + relationship (same as the docVar
  // variants).
  const ct = await zip.file(CONTENT_TYPES_PART).async('string');
  zip.file(
    CONTENT_TYPES_PART,
    injectContentType(ct, `/${SETTINGS_PART}`, SETTINGS_CONTENT_TYPE),
  );
  zip.file(
    DOCUMENT_RELS_PART,
    injectRelationship(
      await zip.file(DOCUMENT_RELS_PART).async('string'),
      SETTINGS_REL_TYPE,
      'settings.xml',
    ),
  );

  const out = await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });
  const outPath = join(outDir, `${baseStem}.${label}.docx`);
  writeFileSync(outPath, out);
  return outPath;
}

// Variant 1: control (untouched copy, renamed for clarity).
const v1 = join(outDir, `${baseStem}.v1-control.docx`);
writeFileSync(v1, baseBytes);

// Variants 2-5: docVar-only variants (original hypothesis — known
// to fail per the first experiment run, kept here for completeness
// in case we want to re-verify alongside the attached-template
// variants).
const docVarVariants = [
  { label: 'v2-version-match', vars: { VerbatimVersion: '6.0.0' } },
  { label: 'v3-version-lower', vars: { VerbatimVersion: '1.0' } },
  { label: 'v4-version-sentinel', vars: { VerbatimVersion: 'cardmirror' } },
  {
    label: 'v5-full-docvar-set',
    vars: {
      OS: 'Windows NT',
      OSVersion: '10.0',
      VerbatimVersion: '6.0.0',
      WordVersion: '16.0',
      Profile: '',
    },
  },
];

console.log(`Wrote: ${v1}`);
for (const v of docVarVariants) {
  const out = await makeVariant(v.label, v.vars);
  console.log(`Wrote: ${out}`);
}

// Variants 6-8: attached-template (new hypothesis after docVars
// failed). Strings dump of Debate.dotm's vbaProject.bin shows
// `AttachedTemplate`, `InstallCheckTemplateName`, and the literal
// "Debate.dotm" together — recognition predicate is almost
// certainly `ActiveDocument.AttachedTemplate.Name = "Debate.dotm"`.
const templateVariants = [
  {
    label: 'v6-template-bare-filename',
    path: 'Debate.dotm',
    docVars: null,
    note: 'Bare filename — Word resolves via its template search path (user template folder, Startup folder, etc.). Most portable if the user has Verbatim installed normally.',
  },
  {
    label: 'v7-template-bare-plus-version',
    path: 'Debate.dotm',
    docVars: { VerbatimVersion: '6.0.0' },
    note: 'Same as v6 plus the VerbatimVersion docVar — covers the case where BOTH signals are needed.',
  },
];

for (const v of templateVariants) {
  const out = await makeTemplateVariant(v.label, v.path, v.docVars);
  console.log(`Wrote: ${out}`);
}

console.log(`
Done. Open each variant in Word (with Verbatim installed) and note
whether the Debate ribbon activates for that document.

If v6 / v7 still don't activate the ribbon, the bare filename
isn't resolving on your machine. Try this from a Word VBA window:

    Debug.Print Application.NormalTemplate.Path
    Debug.Print Application.Options.DefaultFilePath(wdUserTemplatesPath)

Whichever path holds Debate.dotm, you can edit the variant's
word/_rels/document.xml.rels by hand to use the full
"file:///C:/Path/To/Debate.dotm" Target (TargetMode="External"
stays the same) — that's the v8 case.

Or, simpler: take any Word doc, click Verbatimize in the Verbatim
ribbon, Save As, send me the resulting docx and we'll diff it
against base.docx for the exact recognition surface.`);
