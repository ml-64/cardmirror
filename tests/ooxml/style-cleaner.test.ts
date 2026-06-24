// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { Docx } from '../../src/ooxml/docx.js';
import { OoxmlDoc } from '../../src/ooxml/style-clean/ooxml-doc.js';
import { cleanDocumentBytes } from '../../src/ooxml/style-clean/style-cleaner.js';

function bodyXml(inner: string): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>${inner}</w:body></w:document>`;
}
function stylesXml(defs: Array<{ id: string; name?: string; type?: string }>): string {
  const styleEls = defs
    .map((d) => {
      const type = d.type ?? 'paragraph';
      const nameEl = d.name ? `<w:name w:val="${d.name}"/>` : '';
      return `<w:style w:type="${type}" w:styleId="${d.id}">${nameEl}</w:style>`;
    })
    .join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">${styleEls}</w:styles>`;
}

/** A minimal valid .docx (Docx.empty has all the required parts) with a custom
 *  document.xml + styles.xml. */
async function buildDocx(
  documentInner: string,
  styleDefs: Array<{ id: string; name?: string; type?: string }>,
): Promise<Uint8Array> {
  const d = Docx.empty();
  d.writeText('word/document.xml', bodyXml(documentInner));
  d.writeText('word/styles.xml', stylesXml(styleDefs));
  return d.toBuffer();
}

describe('cleanDocumentBytes (end-to-end)', () => {
  it('removes junk, remaps a legacy Tag, strips hyperlinks, and keeps protected styles', async () => {
    const bytes = await buildDocx(
      [
        '<w:p><w:pPr><w:pStyle w:val="Tags"/></w:pPr><w:r><w:t>A tag</w:t></w:r></w:p>',
        '<w:p><w:pPr><w:pStyle w:val="JunkStyle"/></w:pPr><w:r><w:t>junk styled</w:t></w:r></w:p>',
        '<w:p><w:pPr><w:pStyle w:val="ProtectMe"/></w:pPr><w:r><w:t>protected text</w:t></w:r></w:p>',
        '<w:p><w:hyperlink r:id="rId1"><w:r><w:t>link text</w:t></w:r></w:hyperlink></w:p>',
      ].join(''),
      [
        { id: 'Tags', name: 'Tags' },
        { id: 'JunkStyle', name: 'Junk Style' },
        { id: 'ProtectMe', name: 'Protect Me' },
      ],
    );

    const cleaned = await cleanDocumentBytes(bytes, { protectedStyleNames: ['Protect Me'] });

    const outDocx = await Docx.load(cleaned);
    const out = await OoxmlDoc.fromDocx(outDocx);
    const docXml = (await outDocx.readText('word/document.xml')) ?? '';

    // Junk style removed; protected (junk-named) style survives.
    expect(out.styles.byId('JunkStyle')).toBeNull();
    expect(out.styles.byId('ProtectMe')).not.toBeNull();

    // Canonical Heading4 present with its canonical name; the legacy Tags style +
    // its paragraph assignment are remapped away.
    expect(out.styles.byId('Heading4')?.name).toBe('Heading 4');
    expect(out.styles.byId('Tags')).toBeNull();
    expect(docXml).not.toContain('w:val="Tags"');

    // Hyperlink unwrapped; the inner run text is preserved.
    expect(out.hyperlinks()).toHaveLength(0);
    expect(docXml).toContain('link text');
  });

  it('produces output with no dangling style references', async () => {
    const bytes = await buildDocx(
      '<w:p><w:pPr><w:pStyle w:val="Tags"/></w:pPr><w:r><w:t>tag</w:t></w:r></w:p>',
      [{ id: 'Tags', name: 'Tags' }],
    );
    const cleaned = await cleanDocumentBytes(bytes);
    const outDocx = await Docx.load(cleaned);
    const docXml = (await outDocx.readText('word/document.xml')) ?? '';
    const stylesXmlOut = (await outDocx.readText('word/styles.xml')) ?? '';

    // Every pStyle referenced in the body must resolve to a defined styleId.
    const referenced = [...docXml.matchAll(/w:pStyle\s+w:val="([^"]+)"/g)].map((m) => m[1]);
    const defined = new Set(
      [...stylesXmlOut.matchAll(/w:styleId="([^"]+)"/g)].map((m) => m[1]),
    );
    for (const ref of referenced) {
      expect(defined.has(ref!)).toBe(true);
    }
  });
});
