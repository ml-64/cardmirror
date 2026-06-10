/**
 * Voice utterance ↔ undo atomicity (SPEC-voice.md §8): one utterance =
 * one undo step, exactly, and keyboard undo and `scratch that` must
 * agree. These tests are deliberately adversarial — multi-transaction
 * utterances, keyboard edits interleaved inside the history merge
 * window, and back-to-back utterances with no time gap.
 */

import { describe, expect, it } from 'vitest';
import { EditorState, TextSelection } from 'prosemirror-state';
import type { Transaction } from 'prosemirror-state';
import { history, undo } from 'prosemirror-history';
import { schema } from '../../src/schema/index.js';
import {
  voicePlugin,
  voicePluginKey,
  voiceDispatcher,
  sealUtterance,
  patchVoiceState,
} from '../../src/editor/voice/plugin.js';

function paragraph(text: string) {
  return schema.nodes['paragraph']!.create(null, text ? schema.text(text) : []);
}

function makeView(text = 'alpha bravo charlie delta') {
  const doc = schema.nodes['doc']!.create(null, [paragraph(text)]);
  let state = EditorState.create({ doc, plugins: [history(), voicePlugin()] });
  const view = {
    get state() {
      return state;
    },
    dispatch(tr: Transaction) {
      state = state.apply(tr);
    },
  };
  return view;
}

/** Simulate plain keyboard typing: one untagged transaction. */
function type(view: ReturnType<typeof makeView>, text: string, pos: number) {
  view.dispatch(view.state.tr.insertText(text, pos));
}

/** Count how many undo steps it takes to restore the given doc. */
function undosToRestore(view: ReturnType<typeof makeView>, target: string, cap = 10): number {
  for (let n = 0; n <= cap; n++) {
    if (view.state.doc.textContent === target) return n;
    const ok = undo(view.state, view.dispatch);
    if (!ok) return -1;
  }
  return -1;
}

describe('voice utterance atomicity', () => {
  it('groups a multi-transaction utterance into a single undo step', () => {
    const view = makeView();
    const original = view.state.doc.textContent;

    const dispatch = voiceDispatcher(view, 1);
    // Utterance 1, transaction A: select a word.
    dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1, 6)));
    // Transaction B: replace it. C: insert more.
    dispatch(view.state.tr.insertText('ALPHA', 1, 6));
    dispatch(view.state.tr.insertText('!', 6));
    sealUtterance(view);

    expect(view.state.doc.textContent).toBe('ALPHA! bravo charlie delta');
    expect(undosToRestore(view, original)).toBe(1);
  });

  it('keeps back-to-back utterances as separate undo steps', () => {
    const view = makeView();
    const original = view.state.doc.textContent;

    const u1 = voiceDispatcher(view, 1);
    u1(view.state.tr.insertText('one ', 1));
    sealUtterance(view);

    const u2 = voiceDispatcher(view, 2);
    u2(view.state.tr.insertText('two ', 1));
    sealUtterance(view);

    expect(view.state.doc.textContent).toBe('two one alpha bravo charlie delta');
    const afterOneUndo = makeUndone(view, 1);
    expect(afterOneUndo).toBe('one alpha bravo charlie delta');
    expect(undosToRestore(view, original)).toBe(1); // one more undo
  });

  it('does not let keyboard input merge into a sealed utterance', () => {
    const view = makeView();

    const u1 = voiceDispatcher(view, 1);
    u1(view.state.tr.insertText('voice ', 1));
    sealUtterance(view);

    // Immediately-following keyboard typing (inside prosemirror-history's
    // 500 ms merge window — same tick, worst case).
    type(view, 'typed ', 1);

    // First undo removes ONLY the typed text.
    undo(view.state, view.dispatch);
    expect(view.state.doc.textContent).toBe('voice alpha bravo charlie delta');
    // Second undo removes the utterance.
    undo(view.state, view.dispatch);
    expect(view.state.doc.textContent).toBe('alpha bravo charlie delta');
  });

  it('does not merge an utterance into immediately-preceding keyboard input', () => {
    const view = makeView();

    type(view, 'typed ', 1);
    const u1 = voiceDispatcher(view, 1);
    u1(view.state.tr.insertText('voice ', 1));
    sealUtterance(view);

    undo(view.state, view.dispatch);
    expect(view.state.doc.textContent).toBe('typed alpha bravo charlie delta');
  });

  it('keeps dictation segments (distinct utterance ids) individually revertible', () => {
    const view = makeView('');
    const u1 = voiceDispatcher(view, 7);
    u1(view.state.tr.insertText('first segment', 1));
    sealUtterance(view);
    const u2 = voiceDispatcher(view, 8);
    u2(view.state.tr.insertText(' second segment', 14));
    sealUtterance(view);

    undo(view.state, view.dispatch);
    expect(view.state.doc.textContent).toBe('first segment');
  });

  it('state patches (pen change, log) never create undo steps', () => {
    const view = makeView();
    const original = view.state.doc.textContent;

    const u1 = voiceDispatcher(view, 1);
    u1(view.state.tr.insertText('x', 1));
    sealUtterance(view);
    patchVoiceState(view, { pen: { name: 'highlight' } });
    patchVoiceState(view, { appendLog: { utteranceId: 1, kind: 'command', text: 'mark' } });

    expect(voicePluginKey.getState(view.state)?.pen.name).toBe('highlight');
    expect(undosToRestore(view, original)).toBe(1);
  });

  it('maps lastOpRange through subsequent edits (again-but replay target)', () => {
    const view = makeView();
    const u1 = voiceDispatcher(view, 1);
    u1(view.state.tr.setSelection(TextSelection.create(view.state.doc, 7, 12))); // "bravo"
    sealUtterance(view);
    patchVoiceState(view, { lastOpRange: { from: 7, to: 12 } });

    // An edit earlier in the doc shifts positions.
    type(view, 'XX ', 1);

    const st = voicePluginKey.getState(view.state)!;
    expect(st.lastOpRange).toEqual({ from: 10, to: 15 });
    expect(view.state.doc.textBetween(st.lastOpRange!.from, st.lastOpRange!.to)).toBe('bravo');
  });
});

function makeUndone(view: ReturnType<typeof makeView>, times: number): string {
  for (let i = 0; i < times; i++) undo(view.state, view.dispatch);
  return view.state.doc.textContent;
}

describe('voice jump history (go back)', () => {
  const LONG = 'word '.repeat(40).trim(); // > JUMP_MIN positions of text

  it('records jump origins and pops them, without re-recording the back-jump', () => {
    const view = makeView(LONG);
    // Jump from pos 1 to pos 150 — origin recorded.
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1)));
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 150)));
    expect(voicePluginKey.getState(view.state)?.backStack).toEqual([1]);

    // Simulate the goBack transaction (pop + suppressed recording).
    const tr = view.state.tr.setSelection(TextSelection.create(view.state.doc, 1));
    tr.setMeta(voicePluginKey, { popBack: true, suppressJumpRecord: true });
    view.dispatch(tr);
    expect(view.state.selection.head).toBe(1);
    expect(voicePluginKey.getState(view.state)?.backStack).toEqual([]);
  });

  it('ignores small cursor moves', () => {
    const view = makeView(LONG);
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 10)));
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 20)));
    expect(voicePluginKey.getState(view.state)?.backStack ?? []).toHaveLength(0);
  });

  it('remaps stack positions through edits', () => {
    const view = makeView(LONG);
    // 1→60 and 60→160 are both jumps; both origins record.
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 60)));
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 160)));
    expect(voicePluginKey.getState(view.state)?.backStack).toEqual([1, 60]);
    // Insert 10 chars at the doc start — every origin shifts.
    view.dispatch(view.state.tr.insertText('0123456789', 1));
    expect(voicePluginKey.getState(view.state)?.backStack).toEqual([11, 70]);
  });
});
