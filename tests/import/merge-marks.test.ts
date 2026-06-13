/**
 * Run-formatting parsing behavior.
 *
 * Per OOXML spec 17.7.5.10, `<w:pPr>/<w:rPr>` describes the formatting
 * of the paragraph-mark glyph (¶), NOT the runs in the paragraph. So
 * the importer parses each run's own `<w:rPr>` independently. Properties
 * declared on `<w:pPr>/<w:rPr>` do not propagate to runs.
 *
 * (We tried inheritance briefly during development and it caused mass
 * over-formatting on real docs that have `<w:pPr><w:rPr><w:u/></w:rPr></w:pPr>`
 * for paragraph-mark formatting only — see DECISIONS.md.)
 */

import { describe, expect, it } from 'vitest';
import { importDoc } from '../../src/import/index.js';

function bodyXml(inner: string): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${inner}</w:body></w:document>`;
}

describe('run-formatting parsing', () => {
  it('a run with no rPr has no marks', () => {
    const xml = bodyXml(`<w:p><w:r><w:t>plain</w:t></w:r></w:p>`);
    const doc = importDoc(xml);
    const text = doc.firstChild!.firstChild!;
    expect(text.marks).toHaveLength(0);
  });

  it('runs are parsed independently of <w:pPr>/<w:rPr>', () => {
    // The paragraph-mark formatting (in pPr/rPr) does NOT propagate to runs.
    const xml = bodyXml(`
      <w:p>
        <w:pPr>
          <w:rPr>
            <w:u w:val="single"/>
            <w:highlight w:val="yellow"/>
          </w:rPr>
        </w:pPr>
        <w:r><w:t>plain run</w:t></w:r>
      </w:p>
    `);
    const doc = importDoc(xml);
    const text = doc.firstChild!.firstChild!;
    expect(text.marks).toHaveLength(0);
  });

  it('a run with explicit rPr is parsed; pPr/rPr is ignored', () => {
    // Some runs have own underline; others (no rPr) stay plain.
    const xml = bodyXml(`
      <w:p>
        <w:pPr>
          <w:rPr><w:u w:val="single"/></w:rPr>
        </w:pPr>
        <w:r><w:t xml:space="preserve">plain </w:t></w:r>
        <w:r><w:rPr><w:u w:val="single"/></w:rPr><w:t>underlined</w:t></w:r>
        <w:r><w:t xml:space="preserve"> plain</w:t></w:r>
      </w:p>
    `);
    const doc = importDoc(xml);
    const para = doc.firstChild!;
    expect(para.child(0).marks).toHaveLength(0);
    expect(para.child(1).marks.some((m) => m.type.name === 'underline_mark')).toBe(true);
    expect(para.child(2).marks).toHaveLength(0);
  });

  it('explicit-disable bold (b val=0) becomes a bold_off mark, not bold', () => {
    const xml = bodyXml(`
      <w:p>
        <w:r><w:rPr><w:b w:val="0"/></w:rPr><w:t>not bold</w:t></w:r>
      </w:p>
    `);
    const doc = importDoc(xml);
    const text = doc.firstChild!.firstChild!;
    expect(text.marks.some((m) => m.type.name === 'bold')).toBe(false);
    expect(text.marks.some((m) => m.type.name === 'bold_off')).toBe(true);
  });

  it('rStyle is recognized as a named-style mark', () => {
    const xml = bodyXml(`
      <w:p>
        <w:r><w:rPr><w:rStyle w:val="StyleUnderline"/></w:rPr><w:t>u</w:t></w:r>
      </w:p>
    `);
    const doc = importDoc(xml);
    const text = doc.firstChild!.firstChild!;
    expect(text.marks.some((m) => m.type.name === 'underline_mark')).toBe(true);
  });

  it('explicit run-level font_size applies even with named-style mark', () => {
    const xml = bodyXml(`
      <w:p>
        <w:r>
          <w:rPr><w:rStyle w:val="StyleUnderline"/><w:sz w:val="44"/></w:rPr>
          <w:t>large</w:t>
        </w:r>
      </w:p>
    `);
    const doc = importDoc(xml);
    const text = doc.firstChild!.firstChild!;
    expect(text.marks.some((m) => m.type.name === 'underline_mark')).toBe(true);
    const fs = text.marks.find((m) => m.type.name === 'font_size');
    expect(fs).toBeDefined();
    expect(fs!.attrs['halfPoints']).toBe(44);
  });
});
