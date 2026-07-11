// @vitest-environment jsdom
/**
 * In-document section picker (self-ref-picker.ts) — spec:
 * CardMirror-selfref-picker-spec.md §6. Eligibility must match the OLD
 * per-heading-resolution filter (with the two documented deltas), computed
 * from one collectHeadings pass; the UI is a collapsible/filterable outline.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { EditorState, TextSelection } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import type { Node as PMNode } from 'prosemirror-model';
import { schema } from '../../src/schema/index.js';
import { openSelfRefPicker } from '../../src/editor/self-ref-picker.js';

const n = schema.nodes;
function pocket(id: string, text: string): PMNode {
  return n['pocket']!.create({ id }, schema.text(text));
}
function hat(id: string, text: string): PMNode {
  return n['hat']!.create({ id }, schema.text(text));
}
function block(id: string, text: string): PMNode {
  return n['block']!.create({ id }, schema.text(text));
}
function card(id: string, tagText: string, bodyText = 'body words'): PMNode {
  return n['card']!.create(null, [
    n['tag']!.create({ id }, schema.text(tagText)),
    n['card_body']!.create(null, schema.text(bodyText)),
  ]);
}
function zone(children: PMNode[]): PMNode {
  return n['transclusion_ref']!.create({ source_ref: 'other.cmir' }, children);
}
function mkView(doc: PMNode): EditorView {
  const host = document.createElement('div');
  document.body.appendChild(host);
  return new EditorView(host, { state: EditorState.create({ doc, schema }) });
}

/** Fixture (spec §6.1): pocket A > hat B > block C (cards X, Y), empty block
 *  D, block E whose only content is a live zone (inner block Z + card ZC),
 *  and a standalone card W at doc level. */
function fixtureDoc(): PMNode {
  return n['doc']!.create(null, [
    pocket('A', 'POCKET A'),
    hat('B', 'HAT B'),
    block('C', 'BLOCK C'),
    card('X', 'TAG X'),
    card('Y', 'TAG Y'),
    block('D', 'EMPTY BLOCK D'),
    block('E', 'BLOCK E'),
    zone([block('Z', 'ZONE BLOCK Z'), card('ZC', 'ZONE CARD')]),
    card('W', 'TAG W'),
  ]);
}

interface OpenResult {
  view: EditorView;
  rows: HTMLButtonElement[];
  labels: string[];
  pickableLabels: string[];
  pickedIds: string[];
}
function openPicker(doc: PMNode, guardPos: number): OpenResult {
  const view = mkView(doc);
  const pickedIds: string[] = [];
  openSelfRefPicker(view, { title: 'Test picker', guardPos }, (id) => pickedIds.push(id));
  const rows = [...document.querySelectorAll<HTMLButtonElement>('.pmd-selfref-picker-row')];
  const label = (r: HTMLButtonElement): string =>
    r.querySelector('.pmd-selfref-picker-label')!.textContent ?? '';
  return {
    view,
    rows,
    labels: rows.map(label),
    pickableLabels: rows
      .filter((r) => !r.classList.contains('pmd-selfref-picker-row-disabled'))
      .map(label),
    pickedIds,
  };
}
function closeAll(): void {
  // Close via Escape so the picker unregisters its document-level keydown
  // listener (removing the DOM alone would leak it into the next test).
  for (let i = 0; i < 20 && document.querySelector('.pmd-route-overlay'); i++) {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  }
  document.querySelectorAll('.pmd-route-overlay').forEach((o) => o.remove());
  document.body.querySelectorAll(':scope > div').forEach((d) => d.remove());
}
afterEach(closeAll);

/** Doc position just inside a text node whose content contains `needle`. */
function posInText(doc: PMNode, needle: string): number {
  let found = -1;
  doc.descendants((node, pos) => {
    if (found >= 0) return false;
    if (node.isText && node.text?.includes(needle)) found = pos + 1;
    return true;
  });
  if (found < 0) throw new Error(`no text containing "${needle}"`);
  return found;
}

describe('self-ref picker: eligibility (one-pass parity)', () => {
  it('renders the hierarchy, hides zone innards, disables empty sections', () => {
    const doc = fixtureDoc();
    // Guard far away: cursor inside card W's body → W + its ancestors excluded,
    // but A..E stay pickable.
    const res = openPicker(doc, posInText(doc, 'TAG W'));
    // Document order, zone innards absent:
    expect(res.labels).toEqual([
      'POCKET A',
      'HAT B',
      'BLOCK C',
      'TAG X',
      'TAG Y',
      'EMPTY BLOCK D',
      'BLOCK E',
      'TAG W',
    ]);
    // D is disabled (no content under it); W is disabled (guard's section) —
    // and so are A, B, and E, whose SECTIONS all extend through card W (the
    // fixture nests everything under one pocket/hat, and E's span runs to the
    // end of the doc). C's section ends at D, so C and its cards stay pickable.
    expect(res.pickableLabels).toEqual(['BLOCK C', 'TAG X', 'TAG Y']);
    res.view.destroy();
  });

  it('excludes every ancestor section containing the cursor, keeps siblings', () => {
    const doc = fixtureDoc();
    // Cursor inside card X's body: X, C, B, A all contain it; Y/E/W do not.
    const res = openPicker(doc, posInText(doc, 'TAG X'));
    expect(res.pickableLabels).toEqual(['TAG Y', 'BLOCK E', 'TAG W']);
    res.view.destroy();
  });

  it('guard ON the heading line excludes that section (spec §3.4 delta 1)', () => {
    const doc = fixtureDoc();
    const res = openPicker(doc, posInText(doc, 'BLOCK C'));
    // C excluded by delta 1 (guard on its heading line), and its ancestors
    // B/A too. The guard test is per-entry, so X and Y (whose card intervals
    // don't contain C's heading) stay pickable — as do E and W. D stays
    // disabled (empty section).
    expect(res.pickableLabels).toEqual(['TAG X', 'TAG Y', 'BLOCK E', 'TAG W']);
    res.view.destroy();
  });

  it('onPick fires once with the heading id; double-click is a no-op', () => {
    const doc = fixtureDoc();
    const res = openPicker(doc, posInText(doc, 'TAG W'));
    const yRow = res.rows[res.labels.indexOf('TAG Y')]!;
    yRow.click();
    yRow.click();
    expect(res.pickedIds).toEqual(['Y']);
    expect(document.querySelector('.pmd-selfref-picker')).toBeNull();
    res.view.destroy();
  });

  it('disabled rows do not pick', () => {
    const doc = fixtureDoc();
    const res = openPicker(doc, posInText(doc, 'TAG W'));
    res.rows[res.labels.indexOf('EMPTY BLOCK D')]!.click();
    expect(res.pickedIds).toEqual([]);
    expect(document.querySelector('.pmd-selfref-picker')).not.toBeNull();
    res.view.destroy();
  });
});

describe('self-ref picker: collapse + filter + keyboard', () => {
  function bigDoc(blocks: number): PMNode {
    const kids: PMNode[] = [pocket('P', 'THE POCKET')];
    for (let b = 0; b < blocks; b++) {
      kids.push(block(`B${b}`, `BLOCK ${b}`));
      for (let c = 0; c < 4; c++) kids.push(card(`T${b}-${c}`, `NEEDLE${b} CARD ${c}`));
    }
    return n['doc']!.create(null, kids);
  }

  it('>150 rows: blocks start collapsed (tags hidden); toggle expands', () => {
    const doc = bigDoc(40); // 1 + 40 + 160 = 201 rows
    const res = openPicker(doc, 1);
    expect(res.rows.length).toBe(201);
    const firstTag = res.rows[res.labels.indexOf('NEEDLE0 CARD 0')]!;
    expect(firstTag.hidden).toBe(true);
    const firstBlock = res.rows[res.labels.indexOf('BLOCK 0')]!;
    firstBlock.querySelector<HTMLElement>('.pmd-selfref-picker-toggle')!.click();
    expect(firstTag.hidden).toBe(false);
    res.view.destroy();
  });

  it('small docs start fully expanded', () => {
    const doc = fixtureDoc();
    const res = openPicker(doc, posInText(doc, 'TAG W'));
    expect(res.rows.every((r) => !r.hidden)).toBe(true);
    res.view.destroy();
  });

  it('filter shows matches + ancestors; Enter picks the first pickable match', () => {
    const doc = bigDoc(40);
    const res = openPicker(doc, 1);
    const filter = document.querySelector<HTMLInputElement>('.pmd-selfref-picker-filter')!;
    filter.value = 'needle7 card 2';
    filter.dispatchEvent(new Event('input'));
    const visible = res.rows.filter((r) => !r.hidden);
    expect(visible.map((r) => r.querySelector('.pmd-selfref-picker-label')!.textContent)).toEqual([
      'THE POCKET',
      'BLOCK 7',
      'NEEDLE7 CARD 2',
    ]);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(res.pickedIds).toEqual(['T7-2']);
    res.view.destroy();
  });

  it('arrow keys navigate visible rows; Enter picks the active row', () => {
    const doc = fixtureDoc();
    const res = openPicker(doc, posInText(doc, 'TAG W'));
    const down = (): boolean =>
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    down(); // → POCKET A
    down(); // → HAT B
    down(); // → BLOCK C
    expect(res.rows[2]!.classList.contains('pmd-selfref-picker-row-active')).toBe(true);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(res.pickedIds).toEqual(['C']);
    res.view.destroy();
  });

  it('Escape closes without picking and restores focus', () => {
    const doc = fixtureDoc();
    const outside = document.createElement('button');
    document.body.appendChild(outside);
    outside.focus();
    const res = openPicker(doc, posInText(doc, 'TAG W'));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(res.pickedIds).toEqual([]);
    expect(document.querySelector('.pmd-selfref-picker')).toBeNull();
    expect(document.activeElement).toBe(outside);
    res.view.destroy();
    outside.remove();
  });
});
