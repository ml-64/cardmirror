import { describe, it, expect } from 'vitest';
import { EditorState, TextSelection } from 'prosemirror-state';
import { schema, newHeadingId } from '../../src/schema/index.js';
import type { Node as PMNode } from 'prosemirror-model';
import {
  repairParagraphPlugin,
  repairParagraphKey,
  findBodyMatches,
  getRepairParagraphState,
  buildSplitForSingleMatch,
  buildExitTransaction,
  designatedCount,
} from '../../src/editor/repair-paragraph-plugin.js';
import { INDENT_STEP_DXA } from '../../src/editor/indent-keymap.js';

const tag = (t: string) => schema.nodes['tag']!.create({ id: newHeadingId() }, schema.text(t));
const cardBody = (t: string) => schema.nodes['card_body']!.create(null, schema.text(t));
const card = (...kids: PMNode[]) => schema.nodes['card']!.createChecked(null, kids);
const doc = (...kids: PMNode[]) => schema.nodes['doc']!.createChecked(null, kids);

/** A state with the plugin, opened on the first card, with `query` applied. */
function workflowState(d: PMNode, query: string): EditorState {
  let state = EditorState.create({ doc: d, plugins: [repairParagraphPlugin()] });
  // first card's range
  let range: { from: number; to: number } | null = null;
  d.forEach((n, offset) => {
    if (!range && n.type.name === 'card') range = { from: offset, to: offset + n.nodeSize };
  });
  state = state.apply(state.tr.setMeta(repairParagraphKey, { type: 'open', cardRange: range! }));
  state = state.apply(state.tr.setMeta(repairParagraphKey, { type: 'setQuery', query }));
  return state;
}

describe('findBodyMatches', () => {
  it('finds matches in body paragraphs, case-insensitive', () => {
    const d = doc(card(tag('T'), cardBody('Alpha beta. Even more beta here.')));
    const range = { from: 0, to: d.firstChild!.nodeSize };
    const m = findBodyMatches(d, range, 'BETA');
    expect(m.length).toBe(2);
    // each match maps to the literal "beta" text
    for (const x of m) expect(d.textBetween(x.from, x.to).toLowerCase()).toBe('beta');
  });

  it('does NOT match in the tag heading', () => {
    const d = doc(card(tag('beta tag'), cardBody('plain body')));
    const range = { from: 0, to: d.firstChild!.nodeSize };
    expect(findBodyMatches(d, range, 'beta')).toHaveLength(0);
  });

  it('does not cross paragraph boundaries and is scoped to the card', () => {
    const d = doc(
      card(tag('T'), cardBody('one two'), cardBody('three two')),
      card(tag('T2'), cardBody('two only here')),
    );
    const firstCard = { from: 0, to: d.firstChild!.nodeSize };
    const m = findBodyMatches(d, firstCard, 'two');
    expect(m.length).toBe(2); // both bodies of the FIRST card only
  });

  it('empty / whitespace query yields nothing', () => {
    const d = doc(card(tag('T'), cardBody('hello world')));
    const range = { from: 0, to: d.firstChild!.nodeSize };
    expect(findBodyMatches(d, range, '')).toHaveLength(0);
    expect(findBodyMatches(d, range, '   ')).toHaveLength(0);
  });

  it('a straight-quote query matches Word smart quotes (and vice versa)', () => {
    // Body uses curly apostrophe + curly double quotes (what Word produces).
    const d = doc(card(tag('T'), cardBody('the court’s “clear” rule')));
    const range = { from: 0, to: d.firstChild!.nodeSize };
    // Straight apostrophe query matches the curly one.
    expect(findBodyMatches(d, range, "court's")).toHaveLength(1);
    // Straight double quotes match the curly pair.
    expect(findBodyMatches(d, range, '"clear"')).toHaveLength(1);
    // And the reverse: a curly query matches a straight-quoted body.
    const d2 = doc(card(tag('T'), cardBody(`it's "fine"`)));
    const range2 = { from: 0, to: d2.firstChild!.nodeSize };
    expect(findBodyMatches(d2, range2, 'it’s')).toHaveLength(1);
    expect(findBodyMatches(d2, range2, '“fine”')).toHaveLength(1);
  });
});

describe('plugin state via meta', () => {
  it('open + setQuery populates matches; close resets', () => {
    const d = doc(card(tag('T'), cardBody('aa bb aa cc')));
    let state = workflowState(d, 'aa');
    expect(getRepairParagraphState(state).active).toBe(true);
    expect(getRepairParagraphState(state).matches.length).toBe(2);
    state = state.apply(state.tr.setMeta(repairParagraphKey, { type: 'close' }));
    expect(getRepairParagraphState(state).active).toBe(false);
    expect(getRepairParagraphState(state).matches).toHaveLength(0);
  });
});

describe('buildSplitForSingleMatch', () => {
  it('splits the body before the single match, phrase starts the new paragraph', () => {
    const d = doc(card(tag('T'), cardBody('intro text. Even now the body continues')));
    const state = workflowState(d, 'Even now');
    expect(getRepairParagraphState(state).matches.length).toBe(1);
    const tr = buildSplitForSingleMatch(state)!;
    expect(tr).not.toBeNull();
    const next = state.apply(tr);
    const bodies: string[] = [];
    next.doc.firstChild!.forEach((c) => {
      if (c.type.name === 'card_body') bodies.push(c.textContent);
    });
    expect(bodies).toEqual(['intro text. ', 'Even now the body continues']);
    // query cleared by the same transaction
    expect(getRepairParagraphState(next).query).toBe('');
    expect(getRepairParagraphState(next).matches).toHaveLength(0);
    // and the card is still a single card with its tag intact
    expect(next.doc.childCount).toBe(1);
    expect(next.doc.firstChild!.firstChild!.type.name).toBe('tag');
  });

  it('no-op when there are multiple matches', () => {
    const d = doc(card(tag('T'), cardBody('beta and beta again')));
    const state = workflowState(d, 'beta');
    expect(getRepairParagraphState(state).matches.length).toBe(2);
    expect(buildSplitForSingleMatch(state)).toBeNull();
  });

  it('no-op when the phrase already starts its paragraph', () => {
    const d = doc(card(tag('T'), cardBody('Even now the body continues here')));
    const state = workflowState(d, 'Even now');
    expect(getRepairParagraphState(state).matches.length).toBe(1);
    // match is at parentOffset 0 → nothing to split
    expect(buildSplitForSingleMatch(state)).toBeNull();
  });

  it('no-op when there are zero matches', () => {
    const d = doc(card(tag('T'), cardBody('nothing here')));
    const state = workflowState(d, 'absent');
    expect(buildSplitForSingleMatch(state)).toBeNull();
  });

  it('Ctrl-Enter on a phrase already starting its paragraph marks it for indent, without splitting', () => {
    const d = doc(card(tag('T'), cardBody('Even now the body continues here')));
    let state = workflowState(d, 'Even now');
    expect(getRepairParagraphState(state).matches.length).toBe(1);
    const before = state.doc;
    // Ctrl-Enter (designate) → no split, but the paragraph is designated and the
    // query is cleared.
    state = state.apply(buildSplitForSingleMatch(state, /* designate */ true)!);
    expect(state.doc.eq(before)).toBe(true); // no break inserted
    expect(designatedCount(state)).toBe(1);
    expect(getRepairParagraphState(state).query).toBe('');
    // Exit indents that first body paragraph by one step.
    state = state.apply(buildExitTransaction(state));
    expect(bodyIndents(state)).toEqual([['Even now the body continues here', INDENT_STEP_DXA]]);
  });
});

/** Read each card_body's [text, indent] from the first card. */
function bodyIndents(state: EditorState): [string, number][] {
  const out: [string, number][] = [];
  state.doc.firstChild!.forEach((c) => {
    if (c.type.name === 'card_body') out.push([c.textContent, Number(c.attrs['indent'] ?? 0)]);
  });
  return out;
}

describe('Ctrl-Enter deferred indentation', () => {
  it('designates the new paragraph; exit indents only it, by one step', () => {
    const d = doc(card(tag('T'), cardBody('A intro. Target sentence here.')));
    let state = workflowState(d, 'Target');
    expect(getRepairParagraphState(state).matches.length).toBe(1);
    state = state.apply(buildSplitForSingleMatch(state, /* designate */ true)!);
    expect(designatedCount(state)).toBe(1);
    // Not indented yet — the indent is deferred to exit.
    expect(bodyIndents(state)).toEqual([
      ['A intro. ', 0],
      ['Target sentence here.', 0],
    ]);
    state = state.apply(buildExitTransaction(state));
    expect(bodyIndents(state)).toEqual([
      ['A intro. ', 0],
      ['Target sentence here.', INDENT_STEP_DXA],
    ]);
    // workflow deactivated on exit
    expect(getRepairParagraphState(state).active).toBe(false);
  });

  it('plain Enter does not designate; exit indents nothing', () => {
    const d = doc(card(tag('T'), cardBody('A intro. Target sentence here.')));
    let state = workflowState(d, 'Target');
    state = state.apply(buildSplitForSingleMatch(state, false)!);
    expect(designatedCount(state)).toBe(0);
    state = state.apply(buildExitTransaction(state));
    expect(bodyIndents(state)).toEqual([
      ['A intro. ', 0],
      ['Target sentence here.', 0],
    ]);
  });

  it('popDesignation drops the most recent designation (workflow undo)', () => {
    const d = doc(card(tag('T'), cardBody('A intro. Target sentence here.')));
    let state = workflowState(d, 'Target');
    state = state.apply(buildSplitForSingleMatch(state, /* designate */ true)!);
    expect(designatedCount(state)).toBe(1);
    state = state.apply(state.tr.setMeta(repairParagraphKey, { type: 'popDesignation' }));
    expect(designatedCount(state)).toBe(0);
    // The designation is gone, so exit indents nothing (the split itself is
    // reversed separately, via the editor's undo history).
    state = state.apply(buildExitTransaction(state));
    expect(bodyIndents(state)).toEqual([
      ['A intro. ', 0],
      ['Target sentence here.', 0],
    ]);
  });

  it('a later split inside a designated paragraph shrinks it — only the FINAL paragraph indents', () => {
    const d = doc(card(tag('T'), cardBody('Intro. First here. Second here.')));
    let state = workflowState(d, 'First here');
    // Ctrl-Enter: mark the "First here. Second here." paragraph.
    state = state.apply(buildSplitForSingleMatch(state, true)!);
    expect(designatedCount(state)).toBe(1);
    // Now split that same paragraph again (plain Enter) before "Second here".
    state = state.apply(state.tr.setMeta(repairParagraphKey, { type: 'setQuery', query: 'Second here' }));
    expect(getRepairParagraphState(state).matches.length).toBe(1);
    state = state.apply(buildSplitForSingleMatch(state, false)!);
    // Exit: the designated marker now resolves to the shrunken middle
    // paragraph, so ONLY that one is indented — not "Second here.".
    state = state.apply(buildExitTransaction(state));
    expect(bodyIndents(state)).toEqual([
      ['Intro. ', 0],
      ['First here. ', INDENT_STEP_DXA],
      ['Second here.', 0],
    ]);
  });
});

describe('exit indent stays inside the workflow card (M5)', () => {
  const findText = (d: PMNode, t: string, off: number): number => {
    let pos = -1;
    d.descendants((n, p) => {
      if (pos === -1 && n.isText && n.text === t) pos = p + off;
      return pos === -1;
    });
    if (pos < 0) throw new Error(`not found: ${t}`);
    return pos;
  };

  it('never indents a designated paragraph outside the workflow card', () => {
    const d = doc(
      card(tag('A'), cardBody('alpha body')),
      card(tag('B'), cardBody('beta body')),
    );
    // Workflow opens on card A.
    let state = workflowState(d, '');
    // Simulate a designated position that has drifted into card B (outside the
    // workflow's card) — record it via the afterSplit path.
    const posInB = findText(state.doc, 'beta body', 2);
    state = state.apply(
      state.tr
        .setSelection(TextSelection.create(state.doc, posInB))
        .setMeta(repairParagraphKey, { type: 'afterSplit', designate: true }),
    );
    expect(designatedCount(state)).toBe(1);

    // Exit: card B's body must be untouched — indent only ever lands inside the
    // card the workflow opened on.
    const after = state.apply(buildExitTransaction(state)).doc;
    let cardB: PMNode | null = null;
    after.forEach((n) => {
      if (n.type.name === 'card' && n.firstChild?.textContent === 'B') cardB = n;
    });
    expect(cardB).not.toBeNull();
    expect(Number(cardB!.child(1).attrs['indent'] ?? 0)).toBe(0);
  });
});
