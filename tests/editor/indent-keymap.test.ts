/**
 * Tab / Shift-Tab paragraph indent behavior.
 */

import { describe, expect, it } from 'vitest';
import { EditorState, TextSelection } from 'prosemirror-state';
import type { Command } from 'prosemirror-state';
import { schema, newHeadingId } from '../../src/schema/index.js';
import {
  indentParagraph,
  outdentParagraph,
  INDENT_STEP_DXA,
} from '../../src/editor/indent-keymap.js';

function makeDoc(children: any[]) {
  return schema.nodes['doc']!.createChecked(null, children);
}
function paragraph(text: string, attrs: Record<string, unknown> = {}) {
  return schema.nodes['paragraph']!.create(attrs, text ? schema.text(text) : []);
}
function tag(text: string, attrs: Record<string, unknown> = {}) {
  return schema.nodes['tag']!.create(
    { id: newHeadingId(), ...attrs },
    text ? schema.text(text) : [],
  );
}
function cardBody(text: string, attrs: Record<string, unknown> = {}) {
  return schema.nodes['card_body']!.create(attrs, text ? schema.text(text) : []);
}

function apply(state: EditorState, cmd: Command): EditorState | null {
  let next: EditorState | null = null;
  const ok = cmd(state, (tr) => { next = state.apply(tr); });
  return ok ? next : null;
}

function cursorAt(doc: any, pos: number): EditorState {
  const state = EditorState.create({ doc });
  return state.apply(state.tr.setSelection(TextSelection.create(state.doc, pos)));
}

function selectionAt(doc: any, from: number, to: number): EditorState {
  const state = EditorState.create({ doc });
  return state.apply(state.tr.setSelection(TextSelection.create(state.doc, from, to)));
}

describe('indentParagraph (Tab)', () => {
  it('with collapsed cursor: inserts a literal tab character', () => {
    const doc = makeDoc([paragraph('hello')]);
    // Cursor between 'h' and 'e' inside the paragraph
    const state = cursorAt(doc, 2);
    const next = apply(state, indentParagraph);
    expect(next).not.toBeNull();
    expect(next!.doc.firstChild!.textContent).toBe('h\tello');
    // The paragraph's `indent` attr is unchanged.
    expect(next!.doc.firstChild!.attrs['indent']).toBe(0);
  });

  it('with selection fully covering a paragraph: bumps its indent by one step', () => {
    const doc = makeDoc([paragraph('hello')]);
    // Select the entire paragraph content (positions 1..6).
    const state = selectionAt(doc, 1, 6);
    const next = apply(state, indentParagraph);
    expect(next).not.toBeNull();
    expect(next!.doc.firstChild!.attrs['indent']).toBe(INDENT_STEP_DXA);
  });

  it('with a partial selection inside one paragraph: defers (returns false)', () => {
    const doc = makeDoc([paragraph('hello world')]);
    // Select just "hello" (positions 1..6, paragraph ends at 12).
    const state = selectionAt(doc, 1, 6);
    expect(apply(state, indentParagraph)).toBeNull();
  });

  it('with a multi-paragraph selection: indents every touched paragraph', () => {
    const doc = makeDoc([
      paragraph('one'),
      paragraph('two'),
      paragraph('three'),
    ]);
    // Span from inside the first paragraph through into the third —
    // this fully encloses paragraph 2.
    const state = selectionAt(doc, 2, 12);
    const next = apply(state, indentParagraph);
    expect(next).not.toBeNull();
    expect(next!.doc.child(0).attrs['indent']).toBe(INDENT_STEP_DXA);
    expect(next!.doc.child(1).attrs['indent']).toBe(INDENT_STEP_DXA);
    expect(next!.doc.child(2).attrs['indent']).toBe(INDENT_STEP_DXA);
  });

  it('stacks on top of an existing indent value', () => {
    const doc = makeDoc([paragraph('hi', { indent: 360 })]);
    const state = selectionAt(doc, 1, 3);
    const next = apply(state, indentParagraph);
    expect(next).not.toBeNull();
    expect(next!.doc.firstChild!.attrs['indent']).toBe(360 + INDENT_STEP_DXA);
  });

  it('works on heading-like paragraphs (e.g. tag inside a card)', () => {
    const doc = makeDoc([
      schema.nodes['card']!.createChecked(null, [tag('Tag text'), cardBody('body')]),
    ]);
    // Select the tag's content. Card starts at 0, tag at 1, tag text spans 2..10.
    const state = selectionAt(doc, 2, 10);
    const next = apply(state, indentParagraph);
    expect(next).not.toBeNull();
    const card = next!.doc.firstChild!;
    expect(card.child(0).attrs['indent']).toBe(INDENT_STEP_DXA);
  });
});

describe('outdentParagraph (Shift-Tab)', () => {
  it('decrements indent on the cursor paragraph (collapsed selection)', () => {
    const doc = makeDoc([paragraph('hi', { indent: 1440 })]);
    const state = cursorAt(doc, 2);
    const next = apply(state, outdentParagraph);
    expect(next).not.toBeNull();
    expect(next!.doc.firstChild!.attrs['indent']).toBe(1440 - INDENT_STEP_DXA);
  });

  it('clamps at 0 — does not produce negative indent', () => {
    const doc = makeDoc([paragraph('hi', { indent: 100 })]);
    const state = cursorAt(doc, 2);
    const next = apply(state, outdentParagraph);
    expect(next).not.toBeNull();
    expect(next!.doc.firstChild!.attrs['indent']).toBe(0);
  });

  it('returns false (defers) when the cursor paragraph has no indent', () => {
    const doc = makeDoc([paragraph('hi')]);
    const state = cursorAt(doc, 2);
    expect(apply(state, outdentParagraph)).toBeNull();
  });

  it('outdents every touched paragraph in a multi-paragraph selection', () => {
    const doc = makeDoc([
      paragraph('one', { indent: 720 }),
      paragraph('two', { indent: 1440 }),
      paragraph('three'),
    ]);
    const state = selectionAt(doc, 2, 12);
    const next = apply(state, outdentParagraph);
    expect(next).not.toBeNull();
    expect(next!.doc.child(0).attrs['indent']).toBe(0);
    expect(next!.doc.child(1).attrs['indent']).toBe(720);
    // The third paragraph was already at 0 and stays there.
    expect(next!.doc.child(2).attrs['indent']).toBe(0);
  });
});
