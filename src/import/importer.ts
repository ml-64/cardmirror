/**
 * OOXML → schema importer.
 *
 * Reads `word/document.xml` (and rels for hyperlinks) and produces a
 * ProseMirror doc.
 *
 * Strategy:
 *   1. Parse document.xml with order preservation.
 *   2. Walk <w:body>'s children.
 *   3. For each paragraph: extract pStyle, walk runs (and hyperlinks),
 *      collect text + marks per run, classify the paragraph by pStyle.
 *   4. Group consecutive paragraphs into cards: a Tag-styled paragraph
 *      starts a card; following Normal-styled paragraphs (until the next
 *      heading-level paragraph) become its body.
 *   5. Wrap everything in a `doc` node.
 *
 * Per ARCHITECTURE.md §3 (round-trip contract / fungibility), aggressive
 * normalization on import is fine — we preserve only what Verbatim and
 * Advanced Verbatim treat as semantic.
 */

import type { Mark, Node as PMNode, NodeType } from 'prosemirror-model';
import { schema } from '../schema/index.js';
import { idFromBookmarkName, newHeadingId } from '../schema/ids.js';
import { normalizeUnderlineMarks } from '../editor/named-style-normalizer-plugin.js';
import { bytesToBase64 } from '../ooxml/base64.js';
import {
  attrs as attrsOf,
  children as childrenOf,
  findChild,
  parseXml,
  textContent,
  type XmlNode,
} from '../ooxml/parse.js';
import {
  PSTYLE_TO_NODE,
  RSTYLE_TO_MARK,
} from '../ooxml/styles.js';

interface ParaInfo {
  /** Schema node type to use for this paragraph (resolved from pStyle). */
  nodeType: string;
  /** Parsed inline content (text nodes + marks). */
  inlines: PMNode[];
  /** Heading id if pmd-heading-* bookmark detected. */
  headingId: string | null;
  /** Original pStyle, for diagnostics. */
  pStyle: string | null;
}

/** rId → relationship target map from word/_rels/document.xml.rels. */
type RelMap = Record<string, string>;

/** A media part loaded from the source docx, keyed by full zip path. */
export interface MediaPart {
  bytes: Uint8Array;
  contentType: string;
}

/** Map of zip paths (e.g. 'word/media/image1.png') to image data. */
export type MediaPartsMap = Map<string, MediaPart>;

interface ImportContext {
  rels: RelMap;
  /** Track active hyperlink rId stack while walking inline content. */
  hyperlinkStack: string[];
  /** Media parts from the source zip; null if not provided (drawings drop). */
  mediaParts: MediaPartsMap | null;
}

/** Public entry: parse document.xml + rels into a schema doc. */
export function importDoc(
  documentXml: string,
  relsXml: string | null = null,
  mediaParts: MediaPartsMap | null = null,
): PMNode {
  const rels = relsXml ? parseRels(relsXml) : {};
  const ctx: ImportContext = { rels, hyperlinkStack: [], mediaParts };

  const root = parseXml(documentXml);
  const docEl = findChild(root, 'w:document');
  if (!docEl) throw new Error('Missing <w:document> root');

  const body = findChild(childrenOf(docEl, 'w:document'), 'w:body');
  if (!body) throw new Error('Missing <w:body>');

  const bodyChildren = childrenOf(body, 'w:body');
  const paragraphs: ParaInfo[] = [];
  for (const node of bodyChildren) {
    if ('w:p' in node) {
      paragraphs.push(parseParagraph(node, ctx));
    }
    // <w:sectPr>, <w:tbl>, etc. — skip for v0.
  }

  return normalizeUnderlineMarks(assembleDoc(paragraphs));
}

function parseRels(relsXml: string): RelMap {
  const root = parseXml(relsXml);
  const relsEl = findChild(root, 'Relationships');
  if (!relsEl) return {};
  const map: RelMap = {};
  for (const rel of childrenOf(relsEl, 'Relationships')) {
    if (!('Relationship' in rel)) continue;
    const a = attrsOf(rel);
    const id = a['Id'];
    const target = a['Target'];
    if (id && target) map[id] = target;
  }
  return map;
}

function parseParagraph(pNode: XmlNode, ctx: ImportContext): ParaInfo {
  const pChildren = childrenOf(pNode, 'w:p');

  // Look for <w:pPr>/<w:pStyle> for the paragraph style.
  // Note: <w:pPr>/<w:rPr> describes the paragraph-mark glyph's formatting
  // per OOXML spec 17.7.5.10 — it does NOT propagate to runs in the
  // paragraph. Runs are formatted by their own rPr plus the pStyle's
  // linked character style. We deliberately do not parse pPr/rPr.
  const pPr = findChild(pChildren, 'w:pPr');
  let pStyle: string | null = null;
  if (pPr) {
    const pStyleEl = findChild(childrenOf(pPr, 'w:pPr'), 'w:pStyle');
    if (pStyleEl) {
      pStyle = attrsOf(pStyleEl)['w:val'] ?? null;
    }
  }

  // Heading id from pmd-heading-* bookmark (if present).
  let headingId: string | null = null;
  for (const c of pChildren) {
    if ('w:bookmarkStart' in c) {
      const name = attrsOf(c)['w:name'];
      if (name) {
        const id = idFromBookmarkName(name);
        if (id) {
          headingId = id;
          break;
        }
      }
    }
  }

  // Walk inline content: <w:r>, <w:hyperlink>, etc.
  const inlines: PMNode[] = [];
  for (const c of pChildren) {
    collectInlines(c, ctx, inlines);
  }

  const nodeType = resolveNodeType(pStyle, inlines);

  return { nodeType, inlines, headingId, pStyle };
}

function collectInlines(node: XmlNode, ctx: ImportContext, out: PMNode[]): void {
  if ('w:r' in node) {
    parseRun(node, ctx, out);
  } else if ('w:hyperlink' in node) {
    const a = attrsOf(node);
    const rId = a['r:id'] ?? a['rId'] ?? '';
    if (rId) ctx.hyperlinkStack.push(rId);
    for (const c of childrenOf(node, 'w:hyperlink')) {
      collectInlines(c, ctx, out);
    }
    if (rId) ctx.hyperlinkStack.pop();
  }
  // Other inline-ish nodes (w:bookmarkStart, w:bookmarkEnd, etc.) — skip.
}

function parseRun(rNode: XmlNode, ctx: ImportContext, out: PMNode[]): void {
  const rChildren = childrenOf(rNode, 'w:r');
  const rPrEl = findChild(rChildren, 'w:rPr');
  const marks = rPrEl ? [...parseRPr(rPrEl).marks] : [];

  // Apply hyperlink mark from active stack.
  if (ctx.hyperlinkStack.length > 0) {
    const top = ctx.hyperlinkStack[ctx.hyperlinkStack.length - 1]!;
    const href = ctx.rels[top];
    if (href) {
      marks.push(schema.marks['link']!.create({ href }));
    }
  }

  // Collect text from <w:t> children (and <w:tab>, <w:br> if needed).
  for (const c of rChildren) {
    if ('w:t' in c) {
      const text = textContent(c);
      if (text.length > 0) {
        try {
          out.push(schema.text(text, marks));
        } catch (_) {
          // Empty text or invalid characters; skip.
        }
      }
    } else if ('w:tab' in c) {
      try {
        out.push(schema.text('\t', marks));
      } catch (_) { /* ignore */ }
    }
    // <w:br/> with type=page is a hard page break; for now just newline.
    // <w:br/> without type is line break.
    else if ('w:br' in c) {
      try {
        out.push(schema.text('\n', marks));
      } catch (_) { /* ignore */ }
    }
    // Inline pictures: <w:drawing><wp:inline>… or floating
    // <w:drawing><wp:anchor>…. Both wrap a picture referenced via
    // r:embed on an <a:blip>. Without media-parts access we can't
    // round-trip the image bytes, so the drawing is silently dropped
    // as before.
    else if ('w:drawing' in c) {
      const imgNode = parseDrawing(c, ctx);
      if (imgNode) out.push(imgNode);
    }
  }
}

/**
 * Walk a <w:drawing> element to find the image's blip embed (relId)
 * and extent (dimensions in EMU), look up the media bytes via the
 * provided rels + media-parts map, and produce an `image` schema node
 * with the bytes embedded as base64.
 *
 * Returns null if any required piece is missing — the relId, the rel
 * lookup, the media file in the zip, etc. The result is the same as
 * the pre-existing behavior (drawing dropped) for any case we can't
 * round-trip cleanly.
 */
function parseDrawing(drawingNode: XmlNode, ctx: ImportContext): PMNode | null {
  if (!ctx.mediaParts) return null;

  const blipEmbed = findFirstAttr(drawingNode, 'a:blip', 'r:embed');
  if (!blipEmbed) return null;

  // Resolve relId → target path (e.g., 'media/image1.png').
  const target = ctx.rels[blipEmbed];
  if (!target) return null;
  // Rel targets are relative to word/document.xml; full zip path is
  // 'word/' + target.
  const zipPath = target.startsWith('/') ? target.slice(1) : `word/${target}`;
  const part = ctx.mediaParts.get(zipPath);
  if (!part) return null;

  // Dimensions from <wp:extent cx="..." cy="..."/> (EMU).
  const cx = parseInt(findFirstAttr(drawingNode, 'wp:extent', 'cx') ?? '0', 10);
  const cy = parseInt(findFirstAttr(drawingNode, 'wp:extent', 'cy') ?? '0', 10);

  const data = bytesToBase64(part.bytes);

  try {
    return schema.nodes['image']!.createChecked({
      data,
      contentType: part.contentType,
      widthEmu: Number.isFinite(cx) && cx > 0 ? cx : 0,
      heightEmu: Number.isFinite(cy) && cy > 0 ? cy : 0,
      alt: '',
    });
  } catch {
    return null;
  }
}

/**
 * Find the first descendant of `root` matching `tagName`, return its
 * value for attribute `attr`. Walks the fast-xml-parser tree shape
 * (each node is an object whose tag-name key is its children array,
 * with attributes under the ':@' key).
 */
function findFirstAttr(root: XmlNode, tagName: string, attr: string): string | null {
  const stack: XmlNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    for (const key of Object.keys(node)) {
      if (key === ':@') continue;
      if (key === tagName) {
        const a = attrsOf(node);
        if (attr in a) return a[attr] ?? null;
        // Also recurse into the matched node's children (the attribute
        // might be on a descendant of the same tag name — defensive).
      }
      const children = (node as Record<string, unknown>)[key];
      if (Array.isArray(children)) {
        for (const c of children) {
          if (c && typeof c === 'object') stack.push(c as XmlNode);
        }
      }
    }
  }
  return null;
}

interface ParsedRPr {
  marks: Mark[];
}

/**
 * Parse a <w:rPr> element into a set of marks.
 *
 * Per OOXML 17.7.5.10, this is meaningful only when rPr is a child of
 * <w:r>. When it's a child of <w:pPr>, it describes the paragraph mark
 * (¶) only — see parseParagraph, which deliberately ignores pPr/rPr.
 */
function parseRPr(rPr: XmlNode): ParsedRPr {
  const marks: Mark[] = [];
  const props = childrenOf(rPr, 'w:rPr');
  // Direct <w:u/> is deferred — we decide between underline_mark and
  // underline_direct after seeing whether rStyle="StyleUnderline" is
  // also present in this rPr (order between rStyle and w:u is not
  // guaranteed by OOXML).
  let sawDirectU = false;

  for (const prop of props) {
    const tag = Object.keys(prop).find((k) => k !== ':@');
    if (!tag) continue;
    const a = attrsOf(prop);

    switch (tag) {
      case 'w:rStyle': {
        const styleId = a['w:val'];
        if (styleId && styleId in RSTYLE_TO_MARK) {
          const markName = RSTYLE_TO_MARK[styleId]!;
          marks.push(schema.marks[markName]!.create());
        }
        // Unknown / empty rStyles are dropped (stylepox cleanup).
        break;
      }
      case 'w:b': {
        if (a['w:val'] !== '0' && a['w:val'] !== 'false') {
          marks.push(schema.marks['bold']!.create());
        }
        break;
      }
      case 'w:i': {
        if (a['w:val'] !== '0' && a['w:val'] !== 'false') {
          marks.push(schema.marks['italic']!.create());
        }
        break;
      }
      case 'w:u': {
        const val = a['w:val'];
        if (val && val !== 'none' && val !== '0') {
          sawDirectU = true;
        }
        break;
      }
      case 'w:color': {
        const c = a['w:val'];
        if (c && /^[0-9a-fA-F]{6}$/.test(c)) {
          marks.push(schema.marks['font_color']!.create({ color: c }));
        }
        break;
      }
      case 'w:sz': {
        const v = a['w:val'];
        const hp = v ? parseInt(v, 10) : NaN;
        if (Number.isFinite(hp) && hp > 0) {
          marks.push(schema.marks['font_size']!.create({ halfPoints: hp }));
        }
        break;
      }
      case 'w:highlight': {
        const c = a['w:val'];
        if (c && c !== 'none') {
          marks.push(schema.marks['highlight']!.create({ color: c }));
        }
        break;
      }
      case 'w:shd': {
        const c = a['w:fill'];
        if (c && /^[0-9a-fA-F]{6}$/.test(c) && c.toLowerCase() !== 'auto') {
          marks.push(schema.marks['shading']!.create({ color: c }));
        }
        break;
      }
      case 'w:rFonts': {
        // Per-run font override. Prefer w:ascii (the primary attribute
        // for English text); fall back to hAnsi or cs if ascii isn't
        // set. We store one font name; the exporter emits it across
        // all three attributes on round-trip.
        const name = a['w:ascii'] || a['w:hAnsi'] || a['w:cs'] || '';
        if (name) {
          marks.push(schema.marks['font_family']!.create({ name }));
        }
        break;
      }
      // Other rPr props (lang, vertAlign, etc.) — drop.
    }
  }

  if (sawDirectU && !marks.some((m) => m.type.name === 'underline_mark')) {
    // <w:u/> without rStyle="StyleUnderline" → direct underline. The
    // named-style-normalizer plugin promotes this to underline_mark
    // if it lands in a body-like textblock; structural textblocks
    // (tag / analytic / pocket / hat / block / undertag) keep
    // underline_direct.
    marks.push(schema.marks['underline_direct']!.create());
  }

  return { marks };
}

function resolveNodeType(pStyle: string | null, _inlines: PMNode[]): string {
  if (pStyle && pStyle in PSTYLE_TO_NODE) {
    return PSTYLE_TO_NODE[pStyle]!;
  }
  // No pStyle (or unknown) → treat as plain Normal paragraph.
  // The card-grouping pass below will reclassify Normals after a Tag
  // into card_body / cite_paragraph as appropriate.
  return 'paragraph';
}

/**
 * Card-grouping pass.
 *
 * Walks the flat paragraph list and groups Tag-rooted sequences into
 * card nodes. Other paragraphs become flat siblings.
 *
 * Conventions:
 *   - A Tag starts a card.
 *   - The card consumes:
 *     - Optionally one cite_paragraph (heuristic: first Normal after a
 *       Tag is treated as cite_paragraph for v0 always; cleaner heuristic
 *       can replace this later).
 *     - Zero or more card_body paragraphs (subsequent Normals).
 *     - An in-card `analytic` (if it appears between tag and body).
 *   - The card ends at the next heading-level paragraph (Tag, Pocket,
 *     Hat, Block, Analytic, Undertag) or end of document.
 *
 * This mirrors the way real Verbatim docs are structured — the card
 * boundary is implicit in the paragraph sequence; we promote it to a
 * schema node for editor-side ergonomics.
 */
function assembleDoc(paragraphs: ParaInfo[]): PMNode {
  const docNodes: PMNode[] = [];
  let i = 0;
  while (i < paragraphs.length) {
    const para = paragraphs[i]!;

    if (para.nodeType === 'analytic') {
      // Start an analytic_unit: analytic + undertag* + card_body*
      const analyticNode = schema.nodes['analytic']!.create(
        attrsForHeading(para.headingId),
        para.inlines,
      );
      const unitChildren: PMNode[] = [analyticNode];
      let j = i + 1;

      // Consume undertags directly attached to the analytic.
      while (j < paragraphs.length && paragraphs[j]!.nodeType === 'undertag') {
        unitChildren.push(
          schema.nodes['undertag']!.create(null, paragraphs[j]!.inlines),
        );
        j++;
      }

      // Body paragraphs: classify by cite_mark presence (same rule as
      // in cards), since analytic_unit now allows cite_paragraph too.
      while (j < paragraphs.length && paragraphs[j]!.nodeType === 'paragraph') {
        const p = paragraphs[j]!;
        const slot = hasCiteMark(p.inlines) ? 'cite_paragraph' : 'card_body';
        unitChildren.push(schema.nodes[slot]!.create(null, p.inlines));
        j++;
      }

      try {
        const unitNode = schema.nodes['analytic_unit']!.createChecked(null, unitChildren);
        docNodes.push(unitNode);
      } catch (_e) {
        // Analytic_unit construction failed — emit children directly at
        // doc level, coercing tags/analytics into wrappers since they
        // can't appear at doc level on their own.
        for (const child of unitChildren) {
          docNodes.push(coerceToDocChild(child));
        }
      }
      i = j;
      continue;
    }

    if (para.nodeType === 'tag') {
      // Start a card: tag + undertag* + (cite_paragraph | analytic)? + card_body*
      const tagNode = schema.nodes['tag']!.create(
        attrsForHeading(para.headingId),
        para.inlines,
      );
      const cardChildren: PMNode[] = [tagNode];
      let j = i + 1;

      // Consume undertags directly attached to the tag.
      while (j < paragraphs.length && paragraphs[j]!.nodeType === 'undertag') {
        cardChildren.push(
          schema.nodes['undertag']!.create(null, paragraphs[j]!.inlines),
        );
        j++;
      }

      // Optional in-card analytic (cite-slot alternative): immediately
      // after the tag/undertags.
      if (j < paragraphs.length && paragraphs[j]!.nodeType === 'analytic') {
        const a = paragraphs[j]!;
        cardChildren.push(
          schema.nodes['analytic']!.create(attrsForHeading(a.headingId), a.inlines),
        );
        j++;
      }

      // Body paragraphs: any Normal paragraph until we hit a heading-
      // level boundary. Classify each as cite_paragraph if its inline
      // content carries any cite_mark, otherwise as card_body. This is
      // content-based (matches what the user sees) rather than position-
      // based, so cards with multiple cite paragraphs round-trip cleanly.
      while (j < paragraphs.length && paragraphs[j]!.nodeType === 'paragraph') {
        const p = paragraphs[j]!;
        const slot = hasCiteMark(p.inlines) ? 'cite_paragraph' : 'card_body';
        cardChildren.push(schema.nodes[slot]!.create(null, p.inlines));
        j++;
      }

      // Construct the card.
      try {
        const cardNode = schema.nodes['card']!.createChecked(null, cardChildren);
        docNodes.push(cardNode);
      } catch (_e) {
        // Card construction failed — emit children directly at doc
        // level, coercing tags/analytics into wrappers. Should be rare
        // since the doc content expression is permissive.
        for (const child of cardChildren) {
          docNodes.push(coerceToDocChild(child));
        }
      }
      i = j;
    } else {
      // Standalone paragraph kind.
      const node = paragraphToNode(para);
      if (node) docNodes.push(node);
      i++;
    }
  }

  // Wrap in doc node. If schema rejects (which would be surprising given
  // our permissive content expression), coerce stray tags/analytics
  // into legal doc-level children and try again.
  try {
    return schema.nodes['doc']!.createChecked(null, docNodes);
  } catch (_e) {
    return schema.nodes['doc']!.createChecked(
      null,
      docNodes.map((n) => coerceToDocChild(n)),
    );
  }
}

/** True if any inline node in the array carries the cite_mark mark. */
function hasCiteMark(inlines: readonly PMNode[]): boolean {
  for (const n of inlines) {
    if (n.marks.some((m) => m.type.name === 'cite_mark')) return true;
  }
  return false;
}

function attrsForHeading(id: string | null): { id: string } {
  return { id: id ?? newHeadingId() };
}

function paragraphToNode(para: ParaInfo): PMNode | null {
  // A "Normal" paragraph at doc level (not under a Tag/Analytic) that
  // contains any cite_mark inline is promoted to cite_paragraph — same
  // content-based classification we use inside cards. Schema allows
  // cite_paragraph at doc level, and this preserves round-trip fidelity
  // for stray F8'd paragraphs not yet wrapped in a card.
  const effectiveType =
    para.nodeType === 'paragraph' && hasCiteMark(para.inlines)
      ? 'cite_paragraph'
      : para.nodeType;
  const nodeType = schema.nodes[effectiveType] as NodeType | undefined;
  if (!nodeType) return null;
  const isHeading = ['pocket', 'hat', 'block', 'analytic'].includes(effectiveType);
  const attrs = isHeading ? attrsForHeading(para.headingId) : null;
  try {
    return nodeType.createChecked(attrs, para.inlines);
  } catch (_e) {
    return null;
  }
}

function coerceToDocChild(node: PMNode): PMNode {
  // Tags and analytics aren't legal at doc level on their own; wrap them
  // in their required parent (card / analytic_unit) so a fallback doc
  // construction still validates.
  if (node.type.name === 'tag') {
    return schema.nodes['card']!.createChecked(null, [node]);
  }
  if (node.type.name === 'analytic') {
    return schema.nodes['analytic_unit']!.createChecked(null, [node]);
  }
  return node;
}
