import { describe, expect, it } from 'vitest';
import { EditorState } from 'prosemirror-state';
import { schema } from '../../src/schema/index.js';
import {
  learnHighlightPlugin,
  flashcardRangeAt,
  flashcardRanges,
  setFlashcardRangesTr,
  type FlashcardRange,
} from '../../src/editor/learn-highlight-plugin.js';

function stateWith(ranges: FlashcardRange[]): EditorState {
  const doc = schema.nodes['doc']!.createChecked(null, [
    schema.nodes['paragraph']!.create(null, schema.text('abcdefghij')),
  ]);
  let state = EditorState.create({ doc, plugins: [learnHighlightPlugin] });
  state = state.apply(setFlashcardRangesTr(state, ranges));
  return state;
}

describe('flashcardRangeAt', () => {
  // Paragraph text positions: 'a'=1 … 'j'=10, end=11.
  const fc: FlashcardRange = { cardId: 'card-1', from: 2, to: 5, kind: 'flashcard' };
  const ai: FlashcardRange = { cardId: 'thread-1', from: 6, to: 9, kind: 'ai' };

  it('returns the range strictly inside it', () => {
    const state = stateWith([fc, ai]);
    expect(flashcardRangeAt(state, 3)?.cardId).toBe('card-1');
    expect(flashcardRangeAt(state, 7)?.cardId).toBe('thread-1');
  });

  it('treats both endpoints as inside (inclusive)', () => {
    const state = stateWith([fc]);
    expect(flashcardRangeAt(state, 2)?.cardId).toBe('card-1'); // from
    expect(flashcardRangeAt(state, 5)?.cardId).toBe('card-1'); // to
  });

  it('returns null outside every range', () => {
    const state = stateWith([fc, ai]);
    expect(flashcardRangeAt(state, 1)).toBeNull();
    expect(flashcardRangeAt(state, 10)).toBeNull();
  });

  it('carries the kind so the caller can pick the ai: / fc: prefix', () => {
    const state = stateWith([fc, ai]);
    expect(flashcardRangeAt(state, 3)?.kind).toBe('flashcard');
    expect(flashcardRangeAt(state, 7)?.kind).toBe('ai');
  });

  it('first match wins when ranges abut at a shared boundary', () => {
    // fc.to === ai2.from === 5: position 5 is in both; first wins.
    const ai2: FlashcardRange = { cardId: 'thread-2', from: 5, to: 8, kind: 'ai' };
    const state = stateWith([fc, ai2]);
    expect(flashcardRangeAt(state, 5)?.cardId).toBe('card-1');
  });

  it('drops zero-width ranges (never matched)', () => {
    // setFlashcardRangesTr filters to > from; a collapsed range is gone.
    const state = stateWith([{ cardId: 'empty', from: 4, to: 4, kind: 'flashcard' }]);
    expect(flashcardRanges(state)).toHaveLength(0);
    expect(flashcardRangeAt(state, 4)).toBeNull();
  });
});
