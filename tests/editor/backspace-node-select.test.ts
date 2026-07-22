/**
 * Backspace/Delete must never NODE-SELECT a whole card / card_body.
 *
 * baseKeymap's Backspace/Delete chains end in `selectNodeBackward` /
 * `selectNodeForward`, which at a card-adjacent boundary select the
 * neighbouring node as a NodeSelection — so one keypress selects the entire
 * card and the next deletes it. `blockBackspaceNodeSelect` /
 * `blockDeleteNodeSelect` prevent that: at a block edge after/before an
 * isolating card they swallow the key (no merge possible), and at a GAP (a
 * caret clicked past the last card) they redirect into the adjacent body and
 * delete there — never a node-selection, never a dead key. Real merges and
 * atom (image) selection are untouched.
 */
import { describe, expect, it } from 'vitest';
import { EditorState, TextSelection, NodeSelection, Selection } from 'prosemirror-state';
import type { Command } from 'prosemirror-state';
import type { Node as PMNode } from 'prosemirror-model';
import { baseKeymap } from 'prosemirror-commands';
import { schema, newHeadingId } from '../../src/schema/index.js';
import {
  backspaceAtTagStart,
  backspaceAtFirstBodyStart,
  deleteAtTagEnd,
  deleteAtContainerEnd,
} from '../../src/editor/tag-keymap.js';
import {
  keepCursorInLeadingBlockOnBlockedMerge,
  blockBackspaceNodeSelect,
  blockDeleteNodeSelect,
} from '../../src/editor/boundary-cursor-keymap.js';

const N = schema.nodes;
const tag = (t: string) => N['tag']!.create({ id: newHeadingId() }, t ? schema.text(t) : []);
const body = (t: string) => N['card_body']!.create(null, t ? schema.text(t) : []);
const card = (...k: PMNode[]) => N['card']!.createChecked(null, k);
const para = (t: string) => N['paragraph']!.create(null, t ? schema.text(t) : []);
const block = (t: string) => N['block']!.create({ id: newHeadingId() }, schema.text(t));
const doc = (...k: PMNode[]) => N['doc']!.createChecked(null, k);

// The exact Backspace / Delete bindings from index.ts:4812, with baseKeymap as
// the fallback that owns selectNode{Backward,Forward}.
const bsChain: Command[] = [
  backspaceAtTagStart,
  backspaceAtFirstBodyStart,
  keepCursorInLeadingBlockOnBlockedMerge,
  blockBackspaceNodeSelect,
  baseKeymap['Backspace'] as Command,
];
const delChain: Command[] = [
  deleteAtTagEnd,
  deleteAtContainerEnd,
  keepCursorInLeadingBlockOnBlockedMerge,
  blockDeleteNodeSelect,
  baseKeymap['Delete'] as Command,
];
function fire(chain: Command[], state: EditorState): EditorState {
  for (const cmd of chain) {
    let next: EditorState = state;
    if (cmd(state, (tr) => { next = state.apply(tr); })) return next;
  }
  return state; // unhandled (browser would delete a char natively)
}
const stateAt = (d: PMNode, pos: number) => EditorState.create({ doc: d, selection: TextSelection.create(d, pos) });
const bodies = (s: EditorState) => { let n = 0; s.doc.descendants((x) => { if (x.type.name === 'card_body') n++; }); return n; };
function nthStart(d: PMNode, type: string, n: number): number {
  let seen = 0; let pos = -1;
  d.descendants((x, p) => { if (x.type.name === type) { seen++; if (seen === n) pos = p + 1; } });
  if (pos < 0) throw new Error(`no ${type} #${n}`);
  return pos;
}

describe('Backspace never node-selects a card / card_body', () => {
  it('start of a paragraph after a card: no-op, no node-selection', () => {
    const d = doc(card(tag('T'), body('abc')), para('hello'));
    const s = fire(bsChain, stateAt(d, nthStart(d, 'paragraph', 1)));
    expect(s.selection).not.toBeInstanceOf(NodeSelection);
    expect(s.doc.eq(d)).toBe(true);
    // A second press still doesn't select/delete the card.
    expect(fire(bsChain, s).doc.eq(d)).toBe(true);
  });

  it('start of a heading after a card: no node-selection', () => {
    const d = doc(card(tag('T'), body('abc')), block('Heading'));
    const s = fire(bsChain, stateAt(d, nthStart(d, 'block', 1)));
    expect(s.selection).not.toBeInstanceOf(NodeSelection);
    expect(s.doc.eq(d)).toBe(true);
  });

  it('GAP after a NON-empty last body (clicked past the card): deletes into the body, no node-selection', () => {
    const d = doc(para('x'), card(tag('T'), body('abc')));
    const s = fire(bsChain, stateAt(d, d.content.size - 1)); // gap: parent is the card
    expect(s.selection).not.toBeInstanceOf(NodeSelection);
    // The caret dropped into the body and one char was deleted — the fix for
    // "backspace at the very end of the doc does nothing".
    let lastBody = '';
    s.doc.descendants((x) => { if (x.type.name === 'card_body') lastBody = x.textContent; });
    expect(lastBody).toBe('ab');
    expect(s.selection.empty).toBe(true);
  });

  it('GAP after an empty last body: moves the caret in, no node-selection', () => {
    const d = doc(para('intro'), card(tag('T'), body('')));
    const s = fire(bsChain, stateAt(d, d.content.size - 1));
    expect(s.selection).not.toBeInstanceOf(NodeSelection);
  });

  it('still MERGES two adjacent bodies (guard does not block real joins)', () => {
    const d = doc(card(tag('T'), body('x'), body('')));
    const s = fire(bsChain, stateAt(d, nthStart(d, 'card_body', 2)));
    expect(s.selection).not.toBeInstanceOf(NodeSelection);
    expect(bodies(s)).toBe(1);
  });

  it('still cleans an empty trailing paragraph after a card', () => {
    const d = doc(card(tag('T'), body('abc')), para(''));
    const s = fire(bsChain, stateAt(d, d.content.size - 1));
    expect(s.selection).not.toBeInstanceOf(NodeSelection);
    let paras = 0; s.doc.descendants((x) => { if (x.type.name === 'paragraph') paras++; });
    expect(paras).toBe(0);
  });

  it('caret inside an emptied last body still merges into the tag (unchanged)', () => {
    const d = doc(para('intro'), card(tag('T'), body('')));
    const s = fire(bsChain, EditorState.create({ doc: d, selection: Selection.atEnd(d) }));
    expect(s.selection).not.toBeInstanceOf(NodeSelection);
    expect(bodies(s)).toBe(0);
  });
});

describe('Delete never forward-node-selects a card / card_body', () => {
  it('end of a paragraph before a card: no-op, no node-selection', () => {
    const d = doc(para('hi'), card(tag('T'), body('abc')));
    const paraEnd = nthStart(d, 'paragraph', 1) + 2; // after "hi"
    const s = fire(delChain, stateAt(d, paraEnd));
    expect(s.selection).not.toBeInstanceOf(NodeSelection);
    expect(s.doc.eq(d)).toBe(true);
  });

  it('GAP before a card (caret at doc start): deletes into the card, no node-selection', () => {
    const d = doc(card(tag('T'), body('abc')), para('y'));
    const s = fire(delChain, stateAt(d, 0)); // gap: parent is the doc
    expect(s.selection).not.toBeInstanceOf(NodeSelection);
    expect(s.selection.empty).toBe(true);
    expect(s.doc.eq(d)).toBe(false); // it edited into the card
  });

  it('still merges forward across two adjacent bodies', () => {
    const d = doc(card(tag('T'), body(''), body('y')));
    const s = fire(delChain, stateAt(d, nthStart(d, 'card_body', 1)));
    expect(s.selection).not.toBeInstanceOf(NodeSelection);
    expect(bodies(s)).toBe(1);
  });
});
