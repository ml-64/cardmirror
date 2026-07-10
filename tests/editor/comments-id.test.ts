/**
 * Comment-id allocation: ids must stay within Word's 32-bit `w:id` range
 * and never collide with ids already present in a loaded document.
 */
import { describe, it, expect } from 'vitest';
import { EditorState } from 'prosemirror-state';
import { schema } from '../../src/schema/index.js';
import {
  loadThreads,
  newCommentId,
  setCommentIdSessionResolver,
  resetSessionCommentIds,
  type Thread,
} from '../../src/editor/comments-plugin.js';

const INT32_MAX = 2_147_483_647;

function threadWithId(id: string): Thread {
  return {
    id,
    comments: [
      { id, author: 'A', initials: 'A', date: '', text: '', kind: 'human', parentId: null },
    ],
  };
}

describe('comment id allocation', () => {
  it('allocates int32-safe ids and seeds past loaded ids', () => {
    const doc = schema.nodes['doc']!.create(null, schema.nodes['paragraph']!.create());
    const state = EditorState.create({ doc });

    // Fresh ids must fit Word's signed-32-bit `w:id`; a Date.now()-based
    // seed (~1.7e12) would overflow it.
    expect(Number(newCommentId())).toBeLessThan(INT32_MAX);

    // Loading threads advances the counter past every loaded id, so the
    // next new comment can't collide with an imported one.
    loadThreads(state, [threadWithId('9000')]);
    expect(Number(newCommentId())).toBeGreaterThan(9000);
  });

  it('uses random session-scoped ids only when the active doc is co-edited', () => {
    // Not co-edited (resolver false): plain incrementing ids.
    setCommentIdSessionResolver(() => false);
    const a = Number(newCommentId());
    const b = Number(newCommentId());
    expect(b).toBe(a + 1);

    // Co-edited active doc: random id in Word's int32 range, well above the
    // sequential counter (so two peers can't collide on the same increment).
    setCommentIdSessionResolver(() => true);
    const r = Number(newCommentId());
    expect(r).toBeGreaterThanOrEqual(1_000_000);
    expect(r).toBeLessThan(INT32_MAX);

    // Per-doc: switch back to a non-co-edited active doc → sequential again.
    setCommentIdSessionResolver(() => false);
    const c = Number(newCommentId());
    const d = Number(newCommentId());
    expect(d).toBe(c + 1);

    resetSessionCommentIds();
    setCommentIdSessionResolver(null);
  });
});
