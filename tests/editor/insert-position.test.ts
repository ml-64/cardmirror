/**
 * `nearestTopLevelInsertPos` — snaps a block-level insert to the nearest
 * doc-level boundary so it never splits the card the cursor sits in.
 */

import { describe, expect, it } from 'vitest';
import { EditorState } from 'prosemirror-state';
import { Fragment, type Node as PMNode } from 'prosemirror-model';
import { schema, newHeadingId } from '../../src/schema/index.js';
import { nearestTopLevelInsertPos } from '../../src/editor/insert-position.js';

const tag = (t: string) => schema.nodes['tag']!.create({ id: newHeadingId() }, schema.text(t));
const body = (t: string) => schema.nodes['card_body']!.create(null, t ? schema.text(t) : []);
const para = (t: string) => schema.nodes['paragraph']!.create(null, t ? schema.text(t) : []);
const card = (...k: PMNode[]) => schema.nodes['card']!.create(null, Fragment.fromArray(k));
const makeDoc = (...k: PMNode[]) => schema.nodes['doc']!.create(null, Fragment.fromArray(k));

const findText = (doc: PMNode, t: string, off: number): number => {
  let p = -1;
  doc.descendants((n, pos) => {
    if (p === -1 && n.isText && n.text === t) p = pos + off;
    return p === -1;
  });
  if (p < 0) throw new Error(`not found: ${t}`);
  return p;
};

describe('nearestTopLevelInsertPos', () => {
  it('caret mid-card snaps to a card boundary, never inside the card', () => {
    const doc = makeDoc(card(tag('T'), body('alpha body')));
    const cardStart = 0;
    const cardEnd = doc.firstChild!.nodeSize; // after the only card
    const pos = findText(doc, 'alpha body', 5); // mid-body
    const snapped = nearestTopLevelInsertPos(doc, pos);
    expect([cardStart, cardEnd]).toContain(snapped);
  });

  it('caret near the top of a card snaps to BEFORE the card', () => {
    const doc = makeDoc(card(tag('T'), body('alpha body')));
    const pos = findText(doc, 'alpha body', 0); // start of body, high in the card
    expect(nearestTopLevelInsertPos(doc, pos)).toBe(0); // before the card
  });

  it('caret near the bottom of a card snaps to AFTER the card', () => {
    const doc = makeDoc(card(tag('T'), body('alpha body')));
    const pos = findText(doc, 'alpha body', 'alpha body'.length); // end of body
    expect(nearestTopLevelInsertPos(doc, pos)).toBe(doc.firstChild!.nodeSize);
  });

  it('picks the correct card when several are present', () => {
    const doc = makeDoc(
      card(tag('A'), body('aaa')),
      card(tag('B'), body('bbb body')),
      card(tag('C'), body('ccc')),
    );
    const secondStart = doc.child(0).nodeSize;
    const secondEnd = secondStart + doc.child(1).nodeSize;
    const pos = findText(doc, 'bbb body', 4); // inside the middle card
    const snapped = nearestTopLevelInsertPos(doc, pos);
    expect([secondStart, secondEnd]).toContain(snapped);
  });

  it('a loose paragraph snaps to its own boundary (no split)', () => {
    const doc = makeDoc(para('loose text here'));
    const pos = findText(doc, 'loose text here', 5);
    const snapped = nearestTopLevelInsertPos(doc, pos);
    expect([0, doc.firstChild!.nodeSize]).toContain(snapped);
  });

  it('a position already at a doc-level gap is returned unchanged', () => {
    const doc = makeDoc(card(tag('A'), body('a')), card(tag('B'), body('b')));
    const gap = doc.child(0).nodeSize; // between the two cards (doc depth)
    expect(nearestTopLevelInsertPos(doc, gap)).toBe(gap);
  });
});

// End-to-end: the guarantee the insert paths (dropzone click-insert,
// quick-card / send-to-speech) rely on — a block-level insert at the SNAPPED
// position lands as a clean sibling, never splitting the card or spawning a
// phantom blank-tag card.
describe('snapped insert keeps the card intact', () => {
  const newCard = () =>
    card(schema.nodes['tag']!.create({ id: newHeadingId() }, schema.text('NEW')), body('new body'));
  const cardsOf = (doc: PMNode): PMNode[] => {
    const out: PMNode[] = [];
    doc.forEach((c) => {
      if (c.type.name === 'card') out.push(c);
    });
    return out;
  };
  const nullIdTags = (doc: PMNode): number => {
    let n = 0;
    doc.descendants((node) => {
      if (node.type.name === 'tag' && node.attrs['id'] == null) n++;
    });
    return n;
  };

  it('inserting a card at the snapped position yields two intact sibling cards', () => {
    const doc = makeDoc(card(tag('T'), body('alpha body')));
    const caret = findText(doc, 'alpha body', 5);
    const snapped = nearestTopLevelInsertPos(doc, caret);
    const st = EditorState.create({ doc });
    const after = st.apply(st.tr.insert(snapped, newCard())).doc;
    expect(cardsOf(after).length).toBe(2);
    expect(cardsOf(after).every((c) => c.firstChild!.type.name === 'tag')).toBe(true);
    expect(nullIdTags(after)).toBe(0);
    expect(() => after.check()).not.toThrow();
  });

  it('inserting at the RAW caret instead splits the card (the bug the snap avoids)', () => {
    const doc = makeDoc(card(tag('T'), body('alpha body')));
    const caret = findText(doc, 'alpha body', 5);
    const st = EditorState.create({ doc });
    const after = st.apply(st.tr.insert(caret, newCard())).doc;
    expect(nullIdTags(after)).toBeGreaterThan(0); // phantom blank-tag card
  });
});
