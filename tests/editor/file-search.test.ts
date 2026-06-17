/**
 * Command-palette file search — matching + object extraction.
 */

import { describe, expect, it } from 'vitest';
import { schema, newHeadingId } from '../../src/schema/index.js';
import { importDoc } from '../../src/import/index.js';
import {
  baseName,
  dirName,
  fileFormat,
  stripFileExt,
  searchFiles,
  searchFileObjects,
  extractFile,
  type FileEntry,
  type FileObject,
  type FileObjectKind,
} from '../../src/editor/file-search.js';

describe('path helpers', () => {
  it('baseName takes the last segment', () => {
    expect(baseName('a/b/c.cmir')).toBe('c.cmir');
    expect(baseName('c.cmir')).toBe('c.cmir');
    expect(baseName('a\\b\\c.cmir')).toBe('c.cmir');
  });
  it('dirName drops the filename', () => {
    expect(dirName('a/b/c.cmir')).toBe('a/b');
    expect(dirName('c.cmir')).toBe('');
  });
  it('fileFormat reads the extension (default cmir)', () => {
    expect(fileFormat('a/b/c.cmir')).toBe('cmir');
    expect(fileFormat('Heg Good.docx')).toBe('docx');
    expect(fileFormat('SHOUTY.DOCX')).toBe('docx');
    expect(fileFormat('no-ext')).toBe('cmir');
  });
  it('stripFileExt removes only the openable extension', () => {
    expect(stripFileExt('Warming Impacts.cmir')).toBe('Warming Impacts');
    expect(stripFileExt('Heg Good.docx')).toBe('Heg Good');
    expect(stripFileExt('my.report.cmir')).toBe('my.report'); // other dots kept
    expect(stripFileExt('plain')).toBe('plain');
  });
});

function file(name: string, relPath = name): FileEntry {
  return { path: `/root/${relPath}`, relPath, name, mtimeMs: 0 };
}

describe('searchFiles', () => {
  const files = [file('Warming Impacts.cmir'), file('Heg Good.cmir'), file('warming good.cmir')];

  it('empty query returns everything', () => {
    expect(searchFiles(files, '').length).toBe(3);
  });

  it('order-independent multi-token AND match', () => {
    const r = searchFiles(files, 'good warming');
    expect(r.map((f) => f.name)).toEqual(['warming good.cmir']);
  });

  it('ranks earlier first-token hits ahead', () => {
    const r = searchFiles(files, 'warming');
    // "warming good" leads with the token at index 0; "Warming Impacts"
    // also starts with it — both rank by first-token index then order.
    expect(r.map((f) => f.name)).toEqual(['Warming Impacts.cmir', 'warming good.cmir']);
  });
});

describe('searchFileObjects', () => {
  const objs: FileObject[] = [
    { kind: 'block', label: 'Warming Bad', detail: '', from: 0, to: 0 },
    { kind: 'tag', label: 'Smith says warming is bad', detail: '', from: 0, to: 0 },
    { kind: 'cite', label: 'Jones 24', detail: 'Heg key', from: 0, to: 0 },
  ];
  it('matches on label across kinds', () => {
    expect(searchFileObjects(objs, 'warming').map((o) => o.kind)).toEqual(['block', 'tag']);
  });
  it('empty query returns all', () => {
    expect(searchFileObjects(objs, '').length).toBe(3);
  });
  it('matches a tag by its card cite, not just its label', () => {
    const withCite: FileObject[] = [
      { kind: 'tag', label: 'Heg good', detail: '', cite: 'Brooks 24', from: 0, to: 0 },
    ];
    // Query is only in the cite, not the tag label.
    expect(searchFileObjects(withCite, 'brooks').map((o) => o.label)).toEqual(['Heg good']);
  });
});

// ── Object extraction ───────────────────────────────────────────────

function citePara(...runs: { text: string; cite?: boolean }[]) {
  const inline = runs.map((r) =>
    schema.text(r.text, r.cite ? [schema.marks['cite_mark']!.create()] : []),
  );
  return schema.nodes['cite_paragraph']!.create(null, inline);
}

function block(text: string) {
  return schema.nodes['block']!.create({ id: newHeadingId() }, schema.text(text));
}

function card(tagText: string, cite: ReturnType<typeof citePara>) {
  return schema.nodes['card']!.createChecked(null, [
    schema.nodes['tag']!.create({ id: newHeadingId() }, schema.text(tagText)),
    cite,
  ]);
}

function sampleDoc() {
  return schema.nodes['doc']!.createChecked(null, [
    block('Warming Bad'),
    card('Smith says X', citePara({ text: 'Smith 23', cite: true })),
  ]);
}

const enabled = (...k: FileObjectKind[]) => new Set<FileObjectKind>(k);

describe('extractFile — objects', () => {
  it('surfaces block, tag, and cite by default', () => {
    const { objects } = extractFile(sampleDoc(), enabled('block', 'tag', 'cite'));
    const byKind = (k: FileObjectKind) => objects.filter((o) => o.kind === k).map((o) => o.label);
    expect(byKind('block')).toEqual(['Warming Bad']);
    expect(byKind('tag')).toEqual(['Smith says X']);
    expect(byKind('cite')).toEqual(['Smith 23']);
  });

  it('the cite object carries its owning tag as detail', () => {
    const cite = extractFile(sampleDoc(), enabled('cite')).objects.find((o) => o.kind === 'cite');
    expect(cite?.detail).toBe('Smith says X');
  });

  it('the tag object carries its card cite — even when the cite KIND is off', () => {
    // `enabled('tag')` only: no standalone CITE rows, but the tag still
    // carries its citation so it stays findable by it.
    const tag = extractFile(sampleDoc(), enabled('tag')).objects.find((o) => o.kind === 'tag');
    expect(tag?.cite).toBe('Smith 23');
  });

  it('a tag is searchable by its cite with the cite kind off', () => {
    const { objects } = extractFile(sampleDoc(), enabled('tag'));
    // "23" appears only in the cite (Smith 23), not the label (Smith says X).
    expect(searchFileObjects(objects, '23').map((o) => o.label)).toEqual(['Smith says X']);
  });

  it('respects the enabled set', () => {
    const { objects } = extractFile(sampleDoc(), enabled('tag'));
    expect(objects.map((o) => o.kind)).toEqual(['tag']);
  });

  it('empty enabled set yields no objects', () => {
    expect(extractFile(sampleDoc(), enabled()).objects).toEqual([]);
  });

  it('every object carries a valid insert range', () => {
    const { objects } = extractFile(sampleDoc(), enabled('block', 'tag', 'cite'));
    for (const o of objects) {
      expect(Number.isFinite(o.from)).toBe(true);
      expect(o.to).toBeGreaterThanOrEqual(o.from);
    }
  });
});

describe('extractFile — outline', () => {
  it('returns the full structural hierarchy with levels, regardless of enabled', () => {
    const { outline } = extractFile(sampleDoc(), enabled()); // nothing enabled for search
    expect(outline.map((o) => [o.kind, o.level, o.label])).toEqual([
      ['block', 3, 'Warming Bad'],
      ['tag', 4, 'Smith says X'],
    ]);
  });

  it('never includes cites (not headings)', () => {
    const { outline } = extractFile(sampleDoc(), enabled('cite'));
    expect(outline.some((o) => o.kind === 'cite')).toBe(false);
  });
});

// In-file object search has full .docx parity because the dive parses .docx
// (via `fromDocx`, which calls `importDoc`) into the SAME schema as .cmir, and
// `extractFile` works off that doc. This guards that a docx-imported doc is
// searchable just like the hand-built ones above.
describe('extractFile — parity with .docx-imported docs', () => {
  function bodyXml(inner: string): string {
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${inner}</w:body></w:document>`;
  }

  it('surfaces block / tag / cite objects from a doc imported from docx XML', () => {
    const doc = importDoc(
      bodyXml(`
        <w:p><w:pPr><w:pStyle w:val="Heading3"/></w:pPr><w:r><w:t>Warming Bad</w:t></w:r></w:p>
        <w:p><w:pPr><w:pStyle w:val="Heading4"/></w:pPr><w:r><w:t>Smith says X</w:t></w:r></w:p>
        <w:p><w:r><w:rPr><w:rStyle w:val="Style13ptBold"/></w:rPr><w:t>Smith 23</w:t></w:r></w:p>
      `),
    );
    const { objects } = extractFile(doc, enabled('block', 'tag', 'cite'));
    const byKind = (k: FileObjectKind) => objects.filter((o) => o.kind === k).map((o) => o.label);
    expect(byKind('block')).toEqual(['Warming Bad']);
    expect(byKind('tag')).toEqual(['Smith says X']);
    expect(byKind('cite')).toEqual(['Smith 23']);
    // And the tag is findable by its card's cite, same as .cmir.
    expect(searchFileObjects(objects, '23').map((o) => o.kind)).toContain('tag');
  });
});
