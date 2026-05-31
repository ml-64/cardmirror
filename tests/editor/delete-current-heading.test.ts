import { describe, it, expect } from 'vitest';
import { EditorState, TextSelection } from 'prosemirror-state';
import type { Node as PMNode } from 'prosemirror-model';
import { schema, newHeadingId } from '../../src/schema/index.js';
import { buildDeleteStructureTr } from '../../src/editor/speech-doc-send.js';

function tag(text: string) {
  return schema.nodes['tag']!.create({ id: newHeadingId() }, schema.text(text));
}
function body(text: string) {
  return schema.nodes['card_body']!.create(null, schema.text(text));
}
function card(tagText: string, bodyText: string) {
  return schema.nodes['card']!.createChecked(null, [tag(tagText), body(bodyText)]);
}
function block(text: string) {
  return schema.nodes['block']!.create({ id: newHeadingId() }, schema.text(text));
}
function para(text: string) {
  return schema.nodes['paragraph']!.create(null, schema.text(text));
}
function makeDoc(children: PMNode[]) {
  return schema.nodes['doc']!.createChecked(null, children);
}

/** First doc position whose text node contains `needle` (a spot the
 *  cursor can sit at "inside" that structure). */
function posInText(doc: PMNode, needle: string): number {
  let found = -1;
  doc.descendants((node, pos) => {
    if (found >= 0) return false;
    if (node.isText && (node.text ?? '').includes(needle)) {
      found = pos + 1;
      return false;
    }
    return true;
  });
  if (found < 0) throw new Error(`text "${needle}" not found`);
  return found;
}

function stateWithCursorIn(doc: PMNode, needle: string): EditorState {
  return EditorState.create({
    doc,
    selection: TextSelection.create(doc, posInText(doc, needle)),
  });
}

function cardsOf(doc: PMNode): PMNode[] {
  const out: PMNode[] = [];
  doc.descendants((n) => {
    if (n.type.name === 'card') out.push(n);
    return true;
  });
  return out;
}

describe('buildDeleteStructureTr', () => {
  it('deletes the cursor card outright — no blank card left behind', () => {
    const doc = makeDoc([card('Tag A', 'body a'), card('Tag B', 'body b')]);
    const state = stateWithCursorIn(doc, 'Tag A');
    const tr = buildDeleteStructureTr(state);
    expect(tr).not.toBeNull();
    const next = state.apply(tr!);
    const cards = cardsOf(next.doc);
    // Exactly the other card remains — not an emptied shell of card A.
    expect(cards).toHaveLength(1);
    expect(cards[0]!.textContent).toContain('Tag B');
    // Nothing in the doc is an empty heading/card.
    expect(next.doc.textContent).not.toContain('Tag A');
    expect(next.doc.textContent).not.toContain('body a');
  });

  it('deleting from the card body still removes the whole card', () => {
    const doc = makeDoc([card('Tag A', 'body a'), card('Tag B', 'body b')]);
    const state = stateWithCursorIn(doc, 'body a');
    const next = state.apply(buildDeleteStructureTr(state)!);
    expect(cardsOf(next.doc)).toHaveLength(1);
    expect(next.doc.textContent).not.toContain('Tag A');
  });

  it('deletes a heading AND its subtree (block + the card under it)', () => {
    const doc = makeDoc([
      block('Block One'),
      card('Under One', 'b1'),
      block('Block Two'),
      card('Under Two', 'b2'),
    ]);
    const state = stateWithCursorIn(doc, 'Block One');
    const next = state.apply(buildDeleteStructureTr(state)!);
    // Block One + its card are gone; Block Two + its card remain.
    expect(next.doc.textContent).not.toContain('Block One');
    expect(next.doc.textContent).not.toContain('Under One');
    expect(next.doc.textContent).toContain('Block Two');
    expect(next.doc.textContent).toContain('Under Two');
    expect(cardsOf(next.doc)).toHaveLength(1);
  });

  it('no-ops (returns null) when the cursor is not in a structure', () => {
    const doc = makeDoc([para('just a loose paragraph')]);
    const state = stateWithCursorIn(doc, 'loose');
    expect(buildDeleteStructureTr(state)).toBeNull();
  });

  it('leaves the cursor at a valid position after the delete', () => {
    const doc = makeDoc([card('Tag A', 'body a'), card('Tag B', 'body b')]);
    const state = stateWithCursorIn(doc, 'Tag A');
    const next = state.apply(buildDeleteStructureTr(state)!);
    // A resolvable text selection lands in the surviving card.
    expect(next.selection.$head.parent.type.name).not.toBe('doc');
    expect(next.doc.textContent).toContain('Tag B');
  });
});
