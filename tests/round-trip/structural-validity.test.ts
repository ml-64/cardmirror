/**
 * Smoke tests confirming exported .docx files have structural validity:
 * the zip parses, the expected parts exist, and the XML is well-formed.
 */

import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { unzipSync } from 'fflate';
import { fromDocx } from '../../src/import/index.js';
import { toDocx } from '../../src/export/index.js';
import { schema, newHeadingId } from '../../src/schema/index.js';
import { parseXml } from '../../src/ooxml/parse.js';
import { discoverDocxFixtures } from './_fixtures.js';

const fixtures = discoverDocxFixtures();

describe('exported docx structural validity', () => {
  it('produces a valid zip with all required parts', async () => {
    const doc = schema.nodes['doc']!.createChecked(null, [
      schema.nodes['pocket']!.create({ id: newHeadingId() }, schema.text('Pocket')),
    ]);
    const bytes = await toDocx(doc);
    const parts = unzipSync(bytes);

    const requiredParts = [
      '[Content_Types].xml',
      '_rels/.rels',
      'word/document.xml',
      'word/styles.xml',
      'word/_rels/document.xml.rels',
    ];
    for (const part of requiredParts) {
      expect(parts[part], `missing required part ${part}`).toBeDefined();
    }
  });

  it('produces well-formed XML in document.xml', async () => {
    const doc = schema.nodes['doc']!.createChecked(null, [
      schema.nodes['pocket']!.create({ id: newHeadingId() }, schema.text('Pocket')),
      schema.nodes['card']!.create(null, [
        schema.nodes['tag']!.create({ id: newHeadingId() }, schema.text('Tag')),
        schema.nodes['card_body']!.create(null, [
          schema.text('plain '),
          schema.text('marked', [
            schema.marks['underline_mark']!.create(),
            schema.marks['highlight']!.create({ color: 'yellow' }),
          ]),
        ]),
      ]),
    ]);
    const bytes = await toDocx(doc);
    const parts = unzipSync(bytes);
    const docXml = new TextDecoder().decode(parts['word/document.xml']!);

    // If the XML is malformed, parseXml will throw.
    expect(() => parseXml(docXml)).not.toThrow();
  });

  it.skipIf(fixtures.length === 0)(
    'round-tripping a real doc still produces well-formed XML',
    async () => {
      // One fixture is enough for a smoke check; discovery sorts by
      // filename, so this is the alphabetically first one.
      const fixture = fixtures[0]!;
      const buf = await readFile(fixture.fullPath);
      const bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
      const imported = await fromDocx(bytes);
      const reExported = await toDocx(imported);
      const parts = unzipSync(reExported);
      const docXml = new TextDecoder().decode(parts['word/document.xml']!);
      expect(() => parseXml(docXml)).not.toThrow();

      const stylesXml = new TextDecoder().decode(parts['word/styles.xml']!);
      expect(() => parseXml(stylesXml)).not.toThrow();

      const relsXml = new TextDecoder().decode(parts['word/_rels/document.xml.rels']!);
      expect(() => parseXml(relsXml)).not.toThrow();
    },
  );

  it('exported styles.xml contains all canonical style ids', async () => {
    const doc = schema.nodes['doc']!.createChecked(null, [
      schema.nodes['paragraph']!.create(null, schema.text('hi')),
    ]);
    const bytes = await toDocx(doc);
    const parts = unzipSync(bytes);
    const stylesXml = new TextDecoder().decode(parts['word/styles.xml']!);

    const requiredStyleIds = [
      'Heading1', 'Heading2', 'Heading3', 'Heading4',
      'Heading1Char', 'Heading2Char', 'Heading3Char', 'Heading4Char',
      'Style13ptBold', 'StyleUnderline', 'Emphasis',
      'Analytic', 'AnalyticChar', 'Undertag', 'UndertagChar',
      'Normal', 'DefaultParagraphFont',
    ];
    for (const id of requiredStyleIds) {
      expect(
        stylesXml.includes(`w:styleId="${id}"`),
        `expected styleId "${id}" in styles.xml`,
      ).toBe(true);
    }
  });

  it('Heading1 in exported styles.xml has Pocket alias and pBdr (boxes)', async () => {
    const doc = schema.nodes['doc']!.createChecked(null, [
      schema.nodes['paragraph']!.create(null, schema.text('hi')),
    ]);
    const bytes = await toDocx(doc);
    const parts = unzipSync(bytes);
    const stylesXml = new TextDecoder().decode(parts['word/styles.xml']!);

    expect(stylesXml).toContain('<w:aliases w:val="Pocket"/>');
    expect(stylesXml).toContain('<w:aliases w:val="Hat"/>');
    expect(stylesXml).toContain('<w:aliases w:val="Block"/>');
    expect(stylesXml).toContain('<w:aliases w:val="Tag"/>');
    expect(stylesXml).toContain('<w:aliases w:val="Cite"/>');
    expect(stylesXml).toContain('<w:aliases w:val="Underline"/>');
    // Pocket box: paragraph borders all four sides.
    expect(stylesXml).toContain('<w:pBdr>');
    // Emphasis box: character border.
    expect(stylesXml).toContain('<w:bdr');
  });
});
