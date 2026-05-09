/**
 * Schema → OOXML exporter.
 *
 * Walks a ProseMirror doc and emits a valid `word/document.xml` plus the
 * matching `word/_rels/document.xml.rels` (collecting hyperlink relationships
 * along the way).
 *
 * Round-trip contract per ARCHITECTURE.md §3:
 *   - Schema-typed structure → canonical Verbatim style references.
 *   - Direct-formatting marks → run/paragraph properties.
 *   - Stable heading IDs → `pmd-heading-<uuid>` bookmarks bracketing the heading paragraph.
 */

import type { Mark, Node as PMNode } from 'prosemirror-model';
import {
  el,
  emptyEl,
  escText,
  XML_PROLOG,
} from '../ooxml/xml.js';
import {
  MARK_TO_RSTYLE,
  NODE_TO_PSTYLE,
} from '../ooxml/styles.js';
import { bookmarkNameForId } from '../schema/ids.js';

interface HyperlinkRel {
  rId: string;
  target: string;
}

export interface ExportResult {
  /** `word/document.xml` content. */
  documentXml: string;
  /** `word/_rels/document.xml.rels` content. */
  relsXml: string;
}

const DOCUMENT_OPEN = `${XML_PROLOG}
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" mc:Ignorable="w14"><w:body>`;

const SECT_PR_AND_DOCUMENT_CLOSE = `<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>`;

const RELS_OPEN = `${XML_PROLOG}
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`;
const RELS_CLOSE = '</Relationships>';

/**
 * Heading-level node types that get a `pmd-heading-<uuid>` bookmark on
 * export (per ARCHITECTURE.md §4 stable heading IDs).
 */
const HEADING_LIKE = new Set(['pocket', 'hat', 'block', 'tag', 'analytic']);

/** Schema container nodes whose children we emit at the parent level. */
const TRANSPARENT_CONTAINERS = new Set([
  'doc',
  'card',
  'analytic_unit',
]);

class DocxExporter {
  private parts: string[] = [];
  private bookmarkCounter = 0;
  private rels: HyperlinkRel[] = [];
  private nextRelId = 2; // rId1 is reserved for styles

  exportDoc(doc: PMNode): ExportResult {
    if (doc.type.name !== 'doc') {
      throw new Error(`Expected doc node, got ${doc.type.name}`);
    }

    this.parts.push(DOCUMENT_OPEN);
    this.emitChildren(doc);
    this.parts.push(SECT_PR_AND_DOCUMENT_CLOSE);

    return {
      documentXml: this.parts.join(''),
      relsXml: this.buildRelsXml(),
    };
  }

  private emitChildren(node: PMNode): void {
    node.forEach((child) => this.emitBlock(child));
  }

  private emitBlock(node: PMNode): void {
    if (TRANSPARENT_CONTAINERS.has(node.type.name)) {
      this.emitChildren(node);
      return;
    }
    // Every other block-level node is a paragraph kind.
    this.emitParagraph(node);
  }

  private emitParagraph(node: PMNode): void {
    const { name } = node.type;
    const pStyle = NODE_TO_PSTYLE[name] ?? null;
    const isHeading = HEADING_LIKE.has(name);
    const id = isHeading ? ((node.attrs['id'] as string | null) ?? null) : null;

    const pPr = pStyle ? `<w:pPr><w:pStyle w:val="${pStyle}"/></w:pPr>` : '';

    this.parts.push('<w:p>');
    this.parts.push(pPr);

    if (id) {
      const wId = this.bookmarkCounter++;
      this.parts.push(emptyEl('w:bookmarkStart', { 'w:id': wId, 'w:name': bookmarkNameForId(id) }));
      this.emitInlines(node);
      this.parts.push(emptyEl('w:bookmarkEnd', { 'w:id': wId }));
    } else {
      this.emitInlines(node);
    }

    this.parts.push('</w:p>');
  }

  private emitInlines(paragraph: PMNode): void {
    paragraph.forEach((child) => {
      if (child.isText) {
        this.emitTextRun(child.text ?? '', child.marks);
      }
      // Inline non-text nodes: none defined for v0; defensive no-op.
    });
  }

  private emitTextRun(text: string, marks: readonly Mark[]): void {
    if (text.length === 0) return;

    const linkMark = marks.find((m) => m.type.name === 'link');
    const otherMarks = linkMark ? marks.filter((m) => m !== linkMark) : marks;

    const run = `<w:r>${this.rPrFromMarks(otherMarks)}<w:t xml:space="preserve">${escText(text)}</w:t></w:r>`;

    if (linkMark) {
      const href = String(linkMark.attrs['href'] ?? '');
      const rId = this.registerHyperlink(href);
      this.parts.push(`<w:hyperlink r:id="${rId}" w:history="1">${run}</w:hyperlink>`);
    } else {
      this.parts.push(run);
    }
  }

  /** Compose <w:rPr>...</w:rPr> from a set of marks. */
  private rPrFromMarks(marks: readonly Mark[]): string {
    if (marks.length === 0) return '';
    const props: string[] = [];

    // Order matters for some validators. Word's typical ordering:
    // rStyle, rFonts, b, bCs, i, iCs, color, sz, szCs, u, highlight, shd, ...

    const rStyleMark = marks.find((m) => m.type.name in MARK_TO_RSTYLE);
    if (rStyleMark) {
      const styleId = MARK_TO_RSTYLE[rStyleMark.type.name];
      if (styleId) props.push(emptyEl('w:rStyle', { 'w:val': styleId }));
    }

    if (marks.some((m) => m.type.name === 'bold')) {
      props.push('<w:b/>');
    }
    if (marks.some((m) => m.type.name === 'italic')) {
      props.push('<w:i/>');
      props.push('<w:iCs/>');
    }

    // undertag_mark style implies italic display; emit italic for parity
    // (per DECISIONS.md: dual-encoding precedent set by underline_mark).
    if (marks.some((m) => m.type.name === 'undertag_mark') &&
        !marks.some((m) => m.type.name === 'italic')) {
      props.push('<w:i/>');
      props.push('<w:iCs/>');
    }

    const colorMark = marks.find((m) => m.type.name === 'font_color');
    if (colorMark) {
      const c = String(colorMark.attrs['color'] ?? '000000');
      props.push(emptyEl('w:color', { 'w:val': c }));
    }

    const sizeMark = marks.find((m) => m.type.name === 'font_size');
    if (sizeMark) {
      const hp = Number(sizeMark.attrs['halfPoints'] ?? 22);
      props.push(emptyEl('w:sz', { 'w:val': hp }));
      props.push(emptyEl('w:szCs', { 'w:val': hp }));
    }

    if (marks.some((m) => m.type.name === 'underline_mark')) {
      // Dual-encoding per NOTES-verbatim.md §5 gotcha #1:
      // emit both rStyle="StyleUnderline" (already above) AND <w:u w:val="single"/>.
      props.push(emptyEl('w:u', { 'w:val': 'single' }));
    }

    const highlightMark = marks.find((m) => m.type.name === 'highlight');
    if (highlightMark) {
      const c = String(highlightMark.attrs['color'] ?? 'yellow');
      props.push(emptyEl('w:highlight', { 'w:val': c }));
    }

    const shadingMark = marks.find((m) => m.type.name === 'shading');
    if (shadingMark) {
      const c = String(shadingMark.attrs['color'] ?? 'D2D2D2');
      props.push(emptyEl('w:shd', { 'w:val': 'clear', 'w:color': 'auto', 'w:fill': c }));
    }

    if (props.length === 0) return '';
    return el('w:rPr', {}, props.join(''));
  }

  private registerHyperlink(href: string): string {
    const existing = this.rels.find((r) => r.target === href);
    if (existing) return existing.rId;
    const rId = `rId${this.nextRelId++}`;
    this.rels.push({ rId, target: href });
    return rId;
  }

  private buildRelsXml(): string {
    const inner: string[] = [];
    inner.push(
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>',
    );
    for (const rel of this.rels) {
      inner.push(
        `<Relationship Id="${rel.rId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${rel.target}" TargetMode="External"/>`,
      );
    }
    return `${RELS_OPEN}${inner.join('')}${RELS_CLOSE}`;
  }
}

/** Public API: schema doc → document.xml + rels. */
export function exportDoc(doc: PMNode): ExportResult {
  return new DocxExporter().exportDoc(doc);
}
