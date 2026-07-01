/**
 * Find / Replace — incremental doc-change rescan equivalence.
 *
 * The plugin maintains its match list incrementally across doc-changing
 * transactions (map existing matches, re-scan only the changed
 * top-level children — see `rescanIncrementalAfterDocChange`). The
 * correctness contract is that this is indistinguishable from a full
 * rescan: after ANY transaction, the live match list must equal what a
 * from-scratch query over the resulting doc produces. Every test here
 * edits a live state and asserts that equivalence against a
 * fresh-state oracle (`setQuery` always runs the whole-doc scan).
 */

import { describe, expect, it } from 'vitest';
import { EditorState } from 'prosemirror-state';
import { schema } from '../../src/schema/index.js';
import {
  findReplaceKey,
  findReplacePlugin,
  runReplaceAll,
} from '../../src/editor/find-replace-plugin.js';

function paragraph(text: string) {
  return text
    ? schema.nodes['paragraph']!.create(null, schema.text(text))
    : schema.nodes['paragraph']!.create(null, []);
}

function makeDoc(children: import('prosemirror-model').Node[]) {
  return schema.nodes['doc']!.createChecked(null, children);
}

interface QueryOpts {
  caseSensitive?: boolean;
  wholeWord?: boolean;
}

function setQuery(state: EditorState, query: string, opts: QueryOpts = {}): EditorState {
  return state.apply(
    state.tr.setMeta(findReplaceKey, {
      type: 'setQuery',
      query,
      caseSensitive: !!opts.caseSensitive,
      wholeWord: !!opts.wholeWord,
      // Anchor 0 + uncategorized keeps ordering equal to document
      // order, so full-array equality is deterministic.
      sortMode: 'uncategorized',
      anchor: 0,
      categoryOrder: ['heading', 'tag', 'analytic', 'undertag', 'cite', 'other'],
    }),
  );
}

/** A live state over `texts` (one paragraph each) with `query` armed. */
function liveState(texts: string[], query: string, opts: QueryOpts = {}): EditorState {
  const state = EditorState.create({
    doc: makeDoc(texts.map(paragraph)),
    schema,
    plugins: [findReplacePlugin()],
  });
  return setQuery(state, query, opts);
}

/** Full-scan oracle: a fresh state over the SAME doc, queried from
 *  scratch, with the live state's current scope re-applied (setScope
 *  also runs a whole-doc scan). */
function oracleMatches(live: EditorState, query: string, opts: QueryOpts = {}) {
  let fresh = EditorState.create({
    doc: live.doc,
    schema,
    plugins: [findReplacePlugin()],
  });
  fresh = setQuery(fresh, query, opts);
  const scope = findReplaceKey.getState(live)!.scope;
  if (scope) {
    fresh = fresh.apply(fresh.tr.setMeta(findReplaceKey, { type: 'setScope', scope }));
  }
  return findReplaceKey.getState(fresh)!.matches;
}

function expectEquivalent(live: EditorState, query: string, opts: QueryOpts = {}): void {
  expect(findReplaceKey.getState(live)!.matches).toEqual(oracleMatches(live, query, opts));
}

/** Doc position of the Nth paragraph's content start (pos of node + 1). */
function blockContentStart(state: EditorState, blockIndex: number): number {
  let pos = -1;
  let seen = 0;
  state.doc.descendants((node, p) => {
    if (node.type.name === 'paragraph') {
      if (seen === blockIndex) pos = p + 1;
      seen++;
      return false;
    }
    return true;
  });
  if (pos < 0) throw new Error(`no paragraph #${blockIndex}`);
  return pos;
}

describe('find-replace incremental rescan equivalence', () => {
  it('edit in a block before the matches (pure position shift)', () => {
    let state = liveState(['no hits here', 'one foo two', 'three foo four'], 'foo');
    expect(findReplaceKey.getState(state)!.matches.length).toBe(2);
    state = state.apply(state.tr.insertText('XYZ ', blockContentStart(state, 0)));
    expectEquivalent(state, 'foo');
    expect(findReplaceKey.getState(state)!.matches.length).toBe(2);
  });

  it('typing completes a new match in a previously matchless block', () => {
    let state = liveState(['fo bar', 'foo baz'], 'foo');
    expect(findReplaceKey.getState(state)!.matches.length).toBe(1);
    // 'fo' -> 'foo' (insert after the 'fo' at content start)
    state = state.apply(state.tr.insertText('o', blockContentStart(state, 0) + 2));
    expectEquivalent(state, 'foo');
    expect(findReplaceKey.getState(state)!.matches.length).toBe(2);
  });

  it('typing inside a match destroys it', () => {
    let state = liveState(['foo', 'foo'], 'foo');
    state = state.apply(state.tr.insertText('x', blockContentStart(state, 0) + 1));
    expectEquivalent(state, 'foo');
    expect(findReplaceKey.getState(state)!.matches.length).toBe(1);
  });

  it('deletion spanning a block boundary (join)', () => {
    let state = liveState(['aaa foo', 'foo bbb', 'ccc foo'], 'foo');
    expect(findReplaceKey.getState(state)!.matches.length).toBe(3);
    // Delete from the middle of block 0 across into block 1, removing
    // block 0's match and block 1's match ('a foo' + newline + 'foo').
    const b0 = blockContentStart(state, 0);
    const b1 = blockContentStart(state, 1);
    state = state.apply(state.tr.delete(b0 + 3, b1 + 3));
    expectEquivalent(state, 'foo');
  });

  it('block split between matches, and split through a match', () => {
    let state = liveState(['hello foo world foo tail'], 'foo');
    expect(findReplaceKey.getState(state)!.matches.length).toBe(2);
    // Split between the two matches.
    state = state.apply(state.tr.split(blockContentStart(state, 0) + 11));
    expectEquivalent(state, 'foo');
    expect(findReplaceKey.getState(state)!.matches.length).toBe(2);
    // Split through the second match ('foo' -> 'f' | 'oo').
    const secondFrom = findReplaceKey.getState(state)!.matches[1]!.from;
    state = state.apply(state.tr.split(secondFrom + 1));
    expectEquivalent(state, 'foo');
    expect(findReplaceKey.getState(state)!.matches.length).toBe(1);
  });

  it('multi-step transaction touching two distant blocks', () => {
    let state = liveState(['foo alpha', 'quiet middle', 'omega foo'], 'foo');
    const tr = state.tr;
    tr.insertText('foo ', blockContentStart(state, 1));
    // Positions after step 1 shift; map through the tr for step 2.
    tr.delete(
      tr.mapping.map(blockContentStart(state, 2)),
      tr.mapping.map(blockContentStart(state, 2) + 6),
    );
    state = state.apply(tr);
    expectEquivalent(state, 'foo');
  });

  it('mark-only transaction (no text change)', () => {
    let state = liveState(['aaa foo bbb', 'ccc foo ddd'], 'foo');
    const before = findReplaceKey.getState(state)!.matches;
    const b0 = blockContentStart(state, 0);
    state = state.apply(
      state.tr.addMark(b0, b0 + 7, schema.marks['font_size']!.create({ halfPoints: 28 })),
    );
    expectEquivalent(state, 'foo');
    expect(findReplaceKey.getState(state)!.matches).toEqual(before);
  });

  it('replace-all in one transaction (doc change + meta together)', () => {
    let state = liveState(['foo a', 'b foo', 'foo c'], 'foo');
    const cmd = runReplaceAll('bar');
    cmd(state, (tr) => {
      state = state.apply(tr);
    });
    expectEquivalent(state, 'foo');
    expect(findReplaceKey.getState(state)!.matches.length).toBe(0);
  });

  it('replacement text that itself contains new matches', () => {
    let state = liveState(['xx yy', 'yy xx'], 'xx');
    const cmd = runReplaceAll('xxxx');
    cmd(state, (tr) => {
      state = state.apply(tr);
    });
    // 'xxxx' contains two non-overlapping 'xx' hits per replacement.
    expectEquivalent(state, 'xx');
    expect(findReplaceKey.getState(state)!.matches.length).toBe(4);
  });

  it('scoped search: edits inside and outside the scope', () => {
    let state = liveState(['foo one', 'foo two', 'foo three'], 'foo');
    const b1 = blockContentStart(state, 1);
    const scope = { from: b1, to: b1 + 7 };
    state = state.apply(state.tr.setMeta(findReplaceKey, { type: 'setScope', scope }));
    expect(findReplaceKey.getState(state)!.matches.length).toBe(1);
    // Edit inside the scope: complete a second in-scope match.
    state = state.apply(state.tr.insertText(' foo', b1 + 7 - 0));
    // (scope maps through the insert; oracle re-applies the live scope)
    expectEquivalent(state, 'foo');
    // Edit outside the scope: still only in-scope matches count.
    state = state.apply(state.tr.insertText('foo ', blockContentStart(state, 0)));
    expectEquivalent(state, 'foo');
  });

  it('scope collapse (scoped region deleted) falls back to whole-doc matches', () => {
    let state = liveState(['foo one', 'target', 'foo three'], 'target');
    const b1 = blockContentStart(state, 1);
    state = state.apply(
      state.tr.setMeta(findReplaceKey, { type: 'setScope', scope: { from: b1, to: b1 + 6 } }),
    );
    expect(findReplaceKey.getState(state)!.matches.length).toBe(1);
    // Delete the entire scoped block's content plus the block itself:
    // the scope collapses to null and the query goes doc-wide again.
    state = state.apply(state.tr.delete(b1 - 1, b1 + 7));
    expect(findReplaceKey.getState(state)!.scope).toBeNull();
    expectEquivalent(state, 'target');
  });

  it('whole-word and case-sensitive rules survive incremental updates', () => {
    const opts = { wholeWord: true, caseSensitive: true };
    let state = liveState(['Foo food foo', 'foo'], 'foo', opts);
    expect(findReplaceKey.getState(state)!.matches.length).toBe(2);
    // Type a word character right after the block-1 'foo' - no longer whole-word.
    state = state.apply(state.tr.insertText('d', blockContentStart(state, 1) + 3));
    expectEquivalent(state, 'foo', opts);
    expect(findReplaceKey.getState(state)!.matches.length).toBe(1);
  });

  it('active match identity survives edits before it', () => {
    let state = liveState(['foo a', 'foo b', 'foo c'], 'foo');
    state = state.apply(state.tr.setMeta(findReplaceKey, { type: 'navigate', dir: 1 }));
    const s1 = findReplaceKey.getState(state)!;
    expect(s1.currentIndex).toBe(1);
    const activeFromBefore = s1.matches[1]!.from;
    state = state.apply(state.tr.insertText('shift ', blockContentStart(state, 0)));
    const s2 = findReplaceKey.getState(state)!;
    // Same match (block 1's 'foo'), shifted by the insertion length.
    expect(s2.matches[s2.currentIndex]!.from).toBe(activeFromBefore + 6);
    expectEquivalent(state, 'foo');
  });

  it('random edit fuzz: 40 mixed edits stay equivalent throughout', () => {
    // Deterministic PRNG so failures reproduce.
    let seed = 0xc0ffee;
    const rand = (n: number): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    let state = liveState(
      ['foo bar foo', 'baz qux', 'foo foo foo', 'plain text here', 'ending foo'],
      'foo',
    );
    const words = ['foo', 'x', ' foo ', 'fo', 'o', 'yy '];
    for (let i = 0; i < 40; i++) {
      const size = state.doc.content.size;
      const kind = rand(3);
      const tr = state.tr;
      if (kind === 0) {
        // Insert a word at a random valid text position.
        const pos = Math.max(1, Math.min(size - 1, 1 + rand(size - 1)));
        tr.insertText(words[rand(words.length)]!, pos);
      } else if (kind === 1 && size > 4) {
        // Delete a small random range.
        const from = Math.max(1, 1 + rand(size - 3));
        const to = Math.min(size - 1, from + 1 + rand(4));
        if (to > from) tr.delete(from, to);
      } else {
        // Split at a random position (skip if invalid for the schema).
        const pos = Math.max(1, Math.min(size - 1, 1 + rand(size - 1)));
        try {
          tr.split(pos);
        } catch {
          tr.insertText('z', pos);
        }
      }
      if (!tr.docChanged) continue;
      state = state.apply(tr);
      expectEquivalent(state, 'foo');
    }
  });
});
