/**
 * Context-aware bold toggle: in body text Mod-B toggles the `bold` mark;
 * inside a bold-by-default structural block (tag/heading) it toggles the
 * `bold_off` override so a word can be un-bolded. The two marks exclude
 * each other.
 */

import { describe, expect, it } from 'vitest';
import { EditorState, TextSelection } from 'prosemirror-state';
import type { Command } from 'prosemirror-state';
import type { Node as PMNode } from 'prosemirror-model';
import { schema, newHeadingId } from '../../src/schema/index.js';
import { toggleBold } from '../../src/editor/ribbon-commands.js';

const { nodes, marks } = schema;

function makeDoc(...children: PMNode[]) {
  return nodes['doc']!.createChecked(null, children);
}
function tag(text: string) {
  return nodes['card']!.createChecked(null, [
    nodes['tag']!.create({ id: newHeadingId() }, schema.text(text)),
  ]);
}
function para(text: string) {
  return nodes['paragraph']!.create(null, schema.text(text));
}

/** Select [a,b) inside the first node of `typeName`. */
function selectIn(d: PMNode, typeName: string, a: number, b: number): EditorState {
  let start = -1;
  d.descendants((n, p) => {
    if (start === -1 && n.type.name === typeName) start = p + 1;
  });
  const s = EditorState.create({ doc: d });
  return s.apply(s.tr.setSelection(TextSelection.create(s.doc, start + a, start + b)));
}

function apply(state: EditorState, cmd: Command): EditorState | null {
  let next: EditorState | null = null;
  const ok = cmd(state, (tr) => { next = state.apply(tr); });
  return ok ? next : null;
}

function marksAt(d: PMNode, needle: string): string[] {
  let found: string[] = [];
  d.descendants((n) => {
    if (n.isText && n.text === needle) found = n.marks.map((m) => m.type.name).sort();
  });
  return found;
}

describe('toggleBold — context-aware', () => {
  it('in a tag, adds bold_off (un-bolds) rather than bold', () => {
    const d = makeDoc(tag('keep cut'));
    // select "cut"
    const next = apply(selectIn(d, 'tag', 5, 8), toggleBold());
    expect(next).not.toBeNull();
    expect(marksAt(next!.doc, 'cut')).toEqual(['bold_off']);
  });

  it('in a tag, toggling again removes bold_off (re-bolds)', () => {
    const d = makeDoc(
      nodes['card']!.createChecked(null, [
        nodes['tag']!.create({ id: newHeadingId() }, [
          schema.text('keep '),
          schema.text('cut', [marks['bold_off']!.create()]),
        ]),
      ]),
    );
    const next = apply(selectIn(d, 'tag', 5, 8), toggleBold());
    expect(next).not.toBeNull();
    expect(marksAt(next!.doc, 'cut')).toEqual([]); // back to default (CSS) bold
  });

  it('in body text, toggles the bold mark as usual', () => {
    const d = makeDoc(para('hello world'));
    const next = apply(selectIn(d, 'paragraph', 0, 5), toggleBold());
    expect(next).not.toBeNull();
    expect(marksAt(next!.doc, 'hello')).toEqual(['bold']);
  });

  it('bold and bold_off are mutually exclusive in the schema', () => {
    const both = marks['bold']!.create().addToSet(
      marks['bold_off']!.create().addToSet([]),
    );
    // addToSet must collapse to a single mark (bold wins, it was added last).
    expect(both.map((m) => m.type.name)).toEqual(['bold']);
  });

  it('cursor in a tag stores bold_off for the next typed text', () => {
    const d = makeDoc(tag('word'));
    const s = EditorState.create({ doc: d });
    // collapsed cursor inside the tag
    let start = -1;
    d.descendants((n, p) => { if (start === -1 && n.type.name === 'tag') start = p + 1; });
    const state = s.apply(s.tr.setSelection(TextSelection.create(s.doc, start + 2)));
    const next = apply(state, toggleBold());
    expect(next).not.toBeNull();
    expect((next!.storedMarks ?? []).some((m) => m.type.name === 'bold_off')).toBe(true);
  });
});
