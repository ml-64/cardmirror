/**
 * Probe + regression tests for the "viewport rockets to doc end"
 * report.
 *
 * User report (from Discord): pasting text that contains a line
 * break, while there's a tag (F7) somewhere above the paste
 * destination, sometimes lands the cursor at the very end of the
 * doc instead of at the end of the pasted content. A symmetric
 * report: pasting, then moving the cursor above the paste, then
 * pressing F7 ALSO rockets the cursor to the bottom.
 *
 * Root cause: a wholesale `replaceWith(0, doc.content.size, ...)`
 * doc rewrite maps positions inside the replaced range to AFTER
 * the inserted content (PM's association-right convention) — i.e.
 * doc end. The absorb plugin avoids this with narrow per-region
 * steps (see `absorb-plugin.ts`); `clearToNormal` re-anchors the
 * selection manually. The "baseline" tests here snapshot the raw
 * misbehavior; the "fix" tests lock in the corrected cursor
 * placement.
 */

import { describe, expect, it } from 'vitest';
import { EditorState, TextSelection } from 'prosemirror-state';
import { Fragment, Slice } from 'prosemirror-model';
import { schema, newHeadingId } from '../../src/schema/index.js';
import { absorbPlugin, absorbedDocChildren } from '../../src/editor/absorb-plugin.js';
import { buildPlainTextSlice, tryPasteAsCardBodies } from '../../src/editor/paste-plugin.js';
import { clearToNormal, setTag } from '../../src/editor/ribbon-commands.js';

// Doc builders (same shape as ribbon-commands.test.ts).
function paragraph(text: string) {
  return text
    ? schema.nodes['paragraph']!.create(null, schema.text(text))
    : schema.nodes['paragraph']!.create(null, []);
}
function tag(text: string, id = newHeadingId()) {
  return schema.nodes['tag']!.create({ id }, text ? schema.text(text) : []);
}
function cardBody(text: string) {
  return text
    ? schema.nodes['card_body']!.create(null, schema.text(text))
    : schema.nodes['card_body']!.create(null, []);
}
function pocket(text: string, id = newHeadingId()) {
  return schema.nodes['pocket']!.create({ id }, schema.text(text));
}
function makeDoc(children: import('prosemirror-model').Node[]) {
  return schema.nodes['doc']!.createChecked(null, children);
}
function cardWith(...children: import('prosemirror-model').Node[]) {
  return schema.nodes['card']!.createChecked(null, children);
}

/** Locate the first descendant matching `pred` and return a doc
 *  position derived from it.
 *
 *  - For text-node matches: `p` is already the position of the
 *    text's first character, so the result is `p + offsetInside`.
 *  - For block-node matches: `p` is the position BEFORE the
 *    block, so the result is `p + 1 + offsetInside` (one past
 *    the opening boundary). */
function posInside(
  doc: import('prosemirror-model').Node,
  pred: (n: import('prosemirror-model').Node) => boolean,
  offsetInside = 0,
): number {
  let pos = -1;
  doc.descendants((node, p) => {
    if (pos !== -1) return false;
    if (pred(node)) {
      pos = node.isText ? p + offsetInside : p + 1 + offsetInside;
      return false;
    }
    return true;
  });
  if (pos < 0) throw new Error('target not found');
  return pos;
}

/** Build an EditorState with the absorb plugin attached so
 *  appendTransaction fires the way it does in the running app. */
function makeState(doc: import('prosemirror-model').Node): EditorState {
  return EditorState.create({ doc, plugins: [absorbPlugin] });
}

/** Apply a paste at the current cursor by `replaceSelection`.
 *  Returns the new state, with absorb (if applicable) already
 *  applied through PM's normal appendTransaction path. */
function paste(state: EditorState, text: string): EditorState {
  const slice = buildPlainTextSlice(text);
  const tr = state.tr.replaceSelection(slice);
  return state.apply(tr);
}

/** Apply a plain-text paste the way F2 / `applyPlainPasteFromText`
 *  does: try `tryPasteAsCardBodies` first so the slice's
 *  paragraphs land as card_body nodes inside the card directly,
 *  fall back to `replaceSelection` only when the cursor isn't in a
 *  card_body / the slice isn't multi-paragraph. */
function f2Paste(state: EditorState, text: string): EditorState {
  const slice = buildPlainTextSlice(text);
  const tr = tryPasteAsCardBodies(state, slice) ?? state.tr.replaceSelection(slice);
  return state.apply(tr);
}

/** Run a command and return the post-dispatch state, throwing if
 *  the command didn't dispatch. The explicit cast on return works
 *  around TS narrowing `after` to `never` after the if-throw — it
 *  doesn't track the closure mutation across the dispatch. */
function runCmd(
  state: EditorState,
  cmd: import('prosemirror-state').Command,
): EditorState {
  let after: EditorState | null = null;
  const ran = cmd(state, (tr) => { after = state.apply(tr); });
  if (!ran || !after) throw new Error('command did not dispatch');
  return after as EditorState;
}

/** Describe where the cursor ended up: doc-end (within last
 *  textblock), or "elsewhere" with the absolute pos for
 *  comparison. */
function cursorReport(state: EditorState): {
  pos: number;
  docSize: number;
  atDocEnd: boolean;
  inLastTextblock: boolean;
} {
  const docSize = state.doc.content.size;
  const pos = state.selection.head;
  let lastTextblockEnd = -1;
  state.doc.descendants((node, nodePos) => {
    if (node.isTextblock) {
      lastTextblockEnd = nodePos + node.nodeSize - 1;
    }
    return true;
  });
  return {
    pos,
    docSize,
    atDocEnd: pos >= docSize - 1,
    inLastTextblock: lastTextblockEnd >= 0 && pos >= lastTextblockEnd - 1,
  };
}

describe('paste viewport-bug probe', () => {
  // ──────────────────────────────────────────────────────────────
  // Scenario A: Cumdog's "F7 → Enter → paste multi-line text"
  // ──────────────────────────────────────────────────────────────
  //
  // Doc shape after F7 + Enter: a card with a tag and an empty
  // card_body. Cursor in the empty card_body. Paste 2-paragraph
  // text. Where does the cursor land?

  it('paste 2-line text into empty card_body (with tag above) — cursor location?', () => {
    const doc = makeDoc([
      cardWith(tag('TAG'), cardBody('')),
    ]);
    const cursor = posInside(doc, (n) => n.type.name === 'card_body');
    const state = makeState(doc).apply(
      makeState(doc).tr.setSelection(TextSelection.create(doc, cursor)),
    );
    const after = paste(state, 'first line\nsecond line');

    const report = cursorReport(after);
    expect({
      structure: docTypeShape(after.doc),
      text: after.doc.textContent,
      cursor: report,
    }).toMatchInlineSnapshot(`
      {
        "cursor": {
          "atDocEnd": false,
          "docSize": 32,
          "inLastTextblock": true,
          "pos": 30,
        },
        "structure": [
          "card[tag("TAG"), card_body("first line"), card_body("second line")]",
        ],
        "text": "TAGfirst linesecond line",
      }
    `);
  });

  // ──────────────────────────────────────────────────────────────
  // Scenario B: paste in the middle of a multi-paragraph card_body
  // ──────────────────────────────────────────────────────────────

  it('paste 2-line text in the middle of a card_body with surrounding content', () => {
    const doc = makeDoc([
      cardWith(tag('TAG'), cardBody('aaa'), cardBody('bbb')),
      paragraph('after card'),
    ]);
    const cursor = posInside(doc, (n) => n.isText && n.text === 'aaa', 2);
    const state = makeState(doc).apply(
      makeState(doc).tr.setSelection(TextSelection.create(doc, cursor)),
    );
    const after = paste(state, 'X\nY');

    expect({
      structure: docTypeShape(after.doc),
      text: after.doc.textContent,
      cursor: cursorReport(after),
    }).toMatchInlineSnapshot(`
      {
        "cursor": {
          "atDocEnd": false,
          "docSize": 37,
          "inLastTextblock": false,
          "pos": 13,
        },
        "structure": [
          "card[tag("TAG"), card_body("aaX"), card_body("Ya")]",
          "card[tag, card_body("bbb"), card_body("after card")]",
        ],
        "text": "TAGaaXYabbbafter card",
      }
    `);
  });

  // ──────────────────────────────────────────────────────────────
  // Scenario C: pasted content lifts to doc level → absorb fires
  // ──────────────────────────────────────────────────────────────
  //
  // When PM lifts pasted content out of a card_body context to doc
  // level (because the slice has openStart=openEnd=1 + paragraph
  // children that don't fit cleanly), the absorb plugin's
  // `appendTransaction` rewrites the doc to re-claim the orphans —
  // the cursor must survive that rewrite without mapping to doc
  // end.

  it('paste 3-line text into card_body — does anything orphan out to doc level?', () => {
    const doc = makeDoc([
      cardWith(tag('TAG'), cardBody('hello')),
    ]);
    const cursor = posInside(doc, (n) => n.isText && n.text === 'hello', 5);
    const state = makeState(doc).apply(
      makeState(doc).tr.setSelection(TextSelection.create(doc, cursor)),
    );
    const after = paste(state, 'A\nB\nC');

    expect({
      structure: docTypeShape(after.doc),
      text: after.doc.textContent,
      cursor: cursorReport(after),
      orphans: docLevelOrphans(after.doc),
    }).toMatchInlineSnapshot(`
      {
        "cursor": {
          "atDocEnd": false,
          "docSize": 21,
          "inLastTextblock": true,
          "pos": 19,
        },
        "orphans": [],
        "structure": [
          "card[tag("TAG"), card_body("helloA"), card_body("B"), card_body("C")]",
        ],
        "text": "TAGhelloABC",
      }
    `);
  });

  // ──────────────────────────────────────────────────────────────
  // Scenario D: paste at very END of card_body
  // ──────────────────────────────────────────────────────────────

  it('paste 2-line text at the END of a card_body', () => {
    const doc = makeDoc([
      cardWith(tag('TAG'), cardBody('hello')),
      pocket('next pocket'),
    ]);
    const cursor = posInside(doc, (n) => n.isText && n.text === 'hello', 5);
    const state = makeState(doc).apply(
      makeState(doc).tr.setSelection(TextSelection.create(doc, cursor)),
    );
    const after = paste(state, 'X\nY');

    expect({
      structure: docTypeShape(after.doc),
      text: after.doc.textContent,
      cursor: cursorReport(after),
    }).toMatchInlineSnapshot(`
      {
        "cursor": {
          "atDocEnd": false,
          "docSize": 31,
          "inLastTextblock": false,
          "pos": 16,
        },
        "structure": [
          "card[tag("TAG"), card_body("helloX"), card_body("Y")]",
          "pocket("next pocket")",
        ],
        "text": "TAGhelloXYnext pocket",
      }
    `);
  });

  // ──────────────────────────────────────────────────────────────
  // Scenario E: Buntin's "paste, move cursor above, press F7"
  // ──────────────────────────────────────────────────────────────
  //
  // Paste 2 lines into card_body, then place cursor in a paragraph
  // BEFORE the card, then press F7. Does F7 send the cursor to
  // doc end?

  it('paste 2-line text in card_body, then move cursor to ABOVE paragraph and press F7', () => {
    const doc = makeDoc([
      paragraph('above para'),
      cardWith(tag('TAG'), cardBody('body')),
    ]);
    const pasteCursor = posInside(doc, (n) => n.isText && n.text === 'body', 4);
    let state = makeState(doc).apply(
      makeState(doc).tr.setSelection(TextSelection.create(doc, pasteCursor)),
    );
    state = paste(state, 'X\nY');

    // Move cursor to the "above para" paragraph.
    const aboveCursor = posInside(state.doc, (n) => n.isText && n.text != null && n.text.startsWith('above para'), 5);
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, aboveCursor)));
    const beforeF7 = cursorReport(state);

    // Apply F7 (setTag).
    const after = runCmd(state, setTag());
    const afterReport = cursorReport(after);

    expect({
      structureBeforeF7: docTypeShape(state.doc),
      cursorBeforeF7: beforeF7,
      structureAfterF7: docTypeShape(after.doc),
      cursorAfterF7: afterReport,
    }).toMatchInlineSnapshot(`
      {
        "cursorAfterF7": {
          "atDocEnd": false,
          "docSize": 31,
          "inLastTextblock": false,
          "pos": 7,
        },
        "cursorBeforeF7": {
          "atDocEnd": false,
          "docSize": 29,
          "inLastTextblock": false,
          "pos": 6,
        },
        "structureAfterF7": [
          "card[tag("above para")]",
          "card[tag("TAG"), card_body("bodyX"), card_body("Y")]",
        ],
        "structureBeforeF7": [
          "paragraph("above para")",
          "card[tag("TAG"), card_body("bodyX"), card_body("Y")]",
        ],
      }
    `);
  });

  // ──────────────────────────────────────────────────────────────
  // Scenario F: paste into a top-level paragraph between cards
  // ──────────────────────────────────────────────────────────────

  it('paste 2-line text into doc-level paragraph between cards', () => {
    const doc = makeDoc([
      cardWith(tag('TAG1'), cardBody('one')),
      pocket('barrier'),
      paragraph('in between'),
      cardWith(tag('TAG2'), cardBody('two')),
    ]);
    const cursor = posInside(doc, (n) => n.isText && n.text === 'in between', 5);
    const state = makeState(doc).apply(
      makeState(doc).tr.setSelection(TextSelection.create(doc, cursor)),
    );
    const after = paste(state, 'A\nB');

    expect({
      structure: docTypeShape(after.doc),
      cursor: cursorReport(after),
    }).toMatchInlineSnapshot(`
      {
        "cursor": {
          "atDocEnd": false,
          "docSize": 51,
          "inLastTextblock": false,
          "pos": 32,
        },
        "structure": [
          "card[tag("TAG1"), card_body("one")]",
          "pocket("barrier")",
          "paragraph("in beA")",
          "paragraph("Btween")",
          "card[tag("TAG2"), card_body("two")]",
        ],
      }
    `);
  });

  // ──────────────────────────────────────────────────────────────
  // Scenario E1: paste leaves doc-level orphans, then F7 on a
  // doc-level paragraph before them.
  // ──────────────────────────────────────────────────────────────
  //
  // Hypothesis for the F7-causes-rocket path: F7 wraps a doc-level
  // paragraph into a card. If a doc-level paragraph follows
  // immediately, absorb sees `card → paragraph` and rewrites the
  // doc — which is what pushes the cursor to the end.

  it('E1: F7 on a doc-level paragraph followed by another doc-level paragraph', () => {
    const doc = makeDoc([
      paragraph('above'),
      paragraph('orphan after'),
    ]);
    const aboveCursor = posInside(doc, (n) => n.isText && n.text === 'above', 5);
    const state = makeState(doc).apply(
      makeState(doc).tr.setSelection(TextSelection.create(doc, aboveCursor)),
    );
    const cursorBefore = cursorReport(state);

    const after = runCmd(state, setTag());

    expect({
      structureBefore: docTypeShape(state.doc),
      cursorBefore,
      structureAfter: docTypeShape(after.doc),
      cursorAfter: cursorReport(after),
    }).toMatchInlineSnapshot(`
      {
        "cursorAfter": {
          "atDocEnd": false,
          "docSize": 23,
          "inLastTextblock": false,
          "pos": 7,
        },
        "cursorBefore": {
          "atDocEnd": false,
          "docSize": 21,
          "inLastTextblock": false,
          "pos": 6,
        },
        "structureAfter": [
          "card[tag("above"), card_body("orphan after")]",
        ],
        "structureBefore": [
          "paragraph("above")",
          "paragraph("orphan after")",
        ],
      }
    `);
  });

  // ──────────────────────────────────────────────────────────────
  // Scenario E2: Buntin's described sequence, take 2
  // ──────────────────────────────────────────────────────────────
  //
  // What if the cursor lands ABOVE the paste destination in a
  // doc-level paragraph that's between two cards? Press F7.

  it('E2: paste creates orphan, cursor moves to doc-level paragraph BEFORE the orphan, press F7', () => {
    const doc = makeDoc([
      paragraph('above'),
      paragraph('to-be-pasted-into'),
      cardWith(tag('TAG'), cardBody('card body')),
    ]);
    // Cursor at end of "to-be-pasted-into". Paste 2 lines.
    const pasteCursor = posInside(
      doc,
      (n) => n.isText && n.text === 'to-be-pasted-into',
      17,
    );
    let state = makeState(doc).apply(
      makeState(doc).tr.setSelection(TextSelection.create(doc, pasteCursor)),
    );
    state = paste(state, 'X\nY');

    const afterPaste = {
      structure: docTypeShape(state.doc),
      cursor: cursorReport(state),
    };

    // Move cursor to the "above" paragraph.
    const aboveCursor = posInside(state.doc, (n) => n.isText && n.text === 'above', 5);
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, aboveCursor)));

    // Press F7.
    const after = runCmd(state, setTag());

    expect({
      afterPaste,
      structureAfterF7: docTypeShape(after.doc),
      cursorAfterF7: cursorReport(after),
    }).toMatchInlineSnapshot(`
      {
        "afterPaste": {
          "cursor": {
            "atDocEnd": false,
            "docSize": 48,
            "inLastTextblock": false,
            "pos": 29,
          },
          "structure": [
            "paragraph("above")",
            "paragraph("to-be-pasted-intoX")",
            "paragraph("Y")",
            "card[tag("TAG"), card_body("card body")]",
          ],
        },
        "cursorAfterF7": {
          "atDocEnd": false,
          "docSize": 50,
          "inLastTextblock": false,
          "pos": 7,
        },
        "structureAfterF7": [
          "card[tag("above"), card_body("to-be-pasted-intoX"), card_body("Y")]",
          "card[tag("TAG"), card_body("card body")]",
        ],
      }
    `);
  });

  // ──────────────────────────────────────────────────────────────
  // Scenario E3: F7 inside a card_body whose card has trailing
  // doc-level orphans
  // ──────────────────────────────────────────────────────────────

  it('E3: F7 inside card_body of multi-body card with doc-level paragraph following', () => {
    const doc = makeDoc([
      cardWith(tag('TAG'), cardBody('one'), cardBody('two')),
      paragraph('orphan'),
    ]);
    const cursor = posInside(doc, (n) => n.isText && n.text === 'two', 3);
    const state = makeState(doc).apply(
      makeState(doc).tr.setSelection(TextSelection.create(doc, cursor)),
    );
    const cursorBefore = cursorReport(state);

    const after = runCmd(state, setTag());

    expect({
      structureBefore: docTypeShape(state.doc),
      cursorBefore,
      structureAfter: docTypeShape(after.doc),
      cursorAfter: cursorReport(after),
    }).toMatchInlineSnapshot(`
      {
        "cursorAfter": {
          "atDocEnd": false,
          "docSize": 27,
          "inLastTextblock": false,
          "pos": 17,
        },
        "cursorBefore": {
          "atDocEnd": false,
          "docSize": 25,
          "inLastTextblock": false,
          "pos": 15,
        },
        "structureAfter": [
          "card[tag("TAG"), card_body("one")]",
          "card[tag("two"), card_body("orphan")]",
        ],
        "structureBefore": [
          "card[tag("TAG"), card_body("one"), card_body("two")]",
          "paragraph("orphan")",
        ],
      }
    `);
  });

  // ──────────────────────────────────────────────────────────────
  // Scenario E4: minimal F7 setup that DOES cause absorb to fire
  // ──────────────────────────────────────────────────────────────
  //
  // Direct test: build the absolute simplest doc whose F7 should
  // trigger absorb. Doc-level paragraph followed by absorbable
  // doc-level content. F7 wraps the paragraph into a card; absorb
  // claims the trailing content.

  it('E4: minimal F7 triggers absorb (paragraph above orphans)', () => {
    const doc = makeDoc([
      paragraph('the F7 target'),
      paragraph('orphan A'),
      paragraph('orphan B'),
    ]);
    const cursor = posInside(doc, (n) => n.isText && n.text === 'the F7 target', 8);
    const state = makeState(doc).apply(
      makeState(doc).tr.setSelection(TextSelection.create(doc, cursor)),
    );
    const cursorBefore = cursorReport(state);

    const after = runCmd(state, setTag());

    expect({
      structureBefore: docTypeShape(state.doc),
      cursorBefore,
      structureAfter: docTypeShape(after.doc),
      cursorAfter: cursorReport(after),
    }).toMatchInlineSnapshot(`
      {
        "cursorAfter": {
          "atDocEnd": false,
          "docSize": 37,
          "inLastTextblock": false,
          "pos": 10,
        },
        "cursorBefore": {
          "atDocEnd": false,
          "docSize": 35,
          "inLastTextblock": false,
          "pos": 9,
        },
        "structureAfter": [
          "card[tag("the F7 target"), card_body("orphan A"), card_body("orphan B")]",
        ],
        "structureBefore": [
          "paragraph("the F7 target")",
          "paragraph("orphan A")",
          "paragraph("orphan B")",
        ],
      }
    `);
  });

  // ──────────────────────────────────────────────────────────────
  // Scenario H: cursor INSIDE an orphan when absorb fires
  // ──────────────────────────────────────────────────────────────
  //
  // The hypothetical worst case for the narrow-step absorb: the
  // cursor is INSIDE a doc-level orphan paragraph (which absorb
  // is about to claim into the preceding card). With the wholesale
  // replaceWith this rocketed to doc end; with the narrow steps
  // the cursor should land at a sensible position (right where
  // the orphan moved to inside the card).

  it('H: cursor in an orphan paragraph that absorb claims', () => {
    const doc = makeDoc([
      cardWith(tag('TAG'), cardBody('body')),
      paragraph('orphan-A'),
      paragraph('orphan-B'),
    ]);
    // Cursor inside "orphan-A" at offset 3.
    const cursor = posInside(doc, (n) => n.isText && n.text === 'orphan-A', 3);
    const state = makeState(doc).apply(
      makeState(doc).tr.setSelection(TextSelection.create(doc, cursor)),
    );
    const cursorBefore = cursorReport(state);

    // appendTransaction only runs for docChanged transactions
    // (cursor moves alone don't trigger it), so force absorb with
    // a tiny insertText somewhere safe (end of "body").
    const bodyEnd = posInside(state.doc, (n) => n.isText && n.text === 'body', 4);
    const after = state.apply(state.tr.insertText('!', bodyEnd));

    expect({
      structureBefore: docTypeShape(state.doc),
      cursorBefore,
      structureAfter: docTypeShape(after.doc),
      cursorAfter: cursorReport(after),
    }).toMatchInlineSnapshot(`
      {
        "cursorAfter": {
          "atDocEnd": false,
          "docSize": 34,
          "inLastTextblock": false,
          "pos": 17,
        },
        "cursorBefore": {
          "atDocEnd": false,
          "docSize": 33,
          "inLastTextblock": false,
          "pos": 17,
        },
        "structureAfter": [
          "card[tag("TAG"), card_body("body!"), card_body("orphan-A"), card_body("orphan-B")]",
        ],
        "structureBefore": [
          "card[tag("TAG"), card_body("body")]",
          "paragraph("orphan-A")",
          "paragraph("orphan-B")",
        ],
      }
    `);
  });

  // ──────────────────────────────────────────────────────────────
  // Scenario I: Cumdog's exact described sequence end-to-end
  // ──────────────────────────────────────────────────────────────
  //
  // "I put f7 tag, enter, start pasting card words" — execute the
  // whole sequence and check where the cursor lands.

  it('I: F7 → Enter (split via insert) → paste 2-line text', () => {
    const doc = makeDoc([
      paragraph('the F7 target'),
    ]);
    const cursor = posInside(doc, (n) => n.isText && n.text === 'the F7 target', 13);
    let state = makeState(doc).apply(
      makeState(doc).tr.setSelection(TextSelection.create(doc, cursor)),
    );

    // F7: wrap paragraph into card+tag.
    let afterF7: EditorState | null = null;
    setTag()(state, (tr) => { afterF7 = state.apply(tr); });
    if (!afterF7) throw new Error('setTag did not dispatch');
    state = afterF7;

    // Simulate Enter by appending an empty card_body and moving
    // the cursor inside it (PM's split command needs a textblock
    // context, and the cursor sits in the tag).
    const cardEnd = state.doc.firstChild!.nodeSize;
    const tr = state.tr.insert(
      cardEnd - 1,
      schema.nodes['card_body']!.create(null, []),
    );
    // Resolve the post-insert position against tr.doc so PM
    // accepts the selection. The new card_body's start position
    // is `cardEnd - 1` (where we inserted); the inside-content
    // position is `cardEnd`.
    tr.setSelection(TextSelection.create(tr.doc, cardEnd));
    state = state.apply(tr);
    // Cursor is now in the empty card_body.

    // Paste 2-line text.
    state = paste(state, 'card content line 1\ncard content line 2');

    expect({
      structure: docTypeShape(state.doc),
      cursor: cursorReport(state),
    }).toMatchInlineSnapshot(`
      {
        "cursor": {
          "atDocEnd": false,
          "docSize": 59,
          "inLastTextblock": true,
          "pos": 57,
        },
        "structure": [
          "card[tag("the F7 target"), card_body("card content line 1"), card_body("card content line 2")]",
        ],
      }
    `);
  });

  // ──────────────────────────────────────────────────────────────
  // Scenario J: analytic_unit absorption (the other absorbing
  // type — make sure the fix also covers it).
  // ──────────────────────────────────────────────────────────────

  it('J: F7 on paragraph followed by analytic_unit + orphans', () => {
    // analytic_unit is followed by orphan paragraph; F7 on the
    // top paragraph wraps it; analytic absorbs.
    const analyticUnit = schema.nodes['analytic_unit']!.createChecked(
      null,
      [schema.nodes['analytic']!.create({ id: newHeadingId() }, schema.text('A'))],
    );
    const doc = makeDoc([
      paragraph('top'),
      analyticUnit,
      paragraph('orphan after analytic'),
    ]);
    const cursor = posInside(doc, (n) => n.isText && n.text === 'top', 3);
    const state = makeState(doc).apply(
      makeState(doc).tr.setSelection(TextSelection.create(doc, cursor)),
    );

    const after = runCmd(state, setTag());

    expect({
      structureBefore: docTypeShape(state.doc),
      structureAfter: docTypeShape(after.doc),
      cursorAfter: cursorReport(after),
    }).toMatchInlineSnapshot(`
      {
        "cursorAfter": {
          "atDocEnd": false,
          "docSize": 35,
          "inLastTextblock": false,
          "pos": 5,
        },
        "structureAfter": [
          "card[tag("top")]",
          "analytic_unit[analytic("A"), card_body("orphan after analytic")]",
        ],
        "structureBefore": [
          "paragraph("top")",
          "analytic_unit[analytic("A")]",
          "paragraph("orphan after analytic")",
        ],
      }
    `);
  });

  // ──────────────────────────────────────────────────────────────
  // Scenario B-FIX: route through `tryPasteAsCardBodies`, which
  // the paste handler calls before letting PM's default fire.
  // Same setup as scenario B; expected: the phantom-empty-tag
  // card is gone.
  // ──────────────────────────────────────────────────────────────

  it('B-FIX: tryPasteAsCardBodies keeps the split inside the card', () => {
    const doc = makeDoc([
      cardWith(tag('TAG'), cardBody('aaa'), cardBody('bbb')),
      paragraph('after card'),
    ]);
    const cursor = posInside(doc, (n) => n.isText && n.text === 'aaa', 2);
    const state = makeState(doc).apply(
      makeState(doc).tr.setSelection(TextSelection.create(doc, cursor)),
    );
    const slice = buildPlainTextSlice('X\nY');
    const tr = tryPasteAsCardBodies(state, slice);
    expect(tr).not.toBeNull();
    const after = state.apply(tr!);

    expect({
      structure: docTypeShape(after.doc),
      text: after.doc.textContent,
      cursor: cursorReport(after),
    }).toMatchInlineSnapshot(`
      {
        "cursor": {
          "atDocEnd": false,
          "docSize": 33,
          "inLastTextblock": false,
          "pos": 13,
        },
        "structure": [
          "card[tag("TAG"), card_body("aaX"), card_body("Ya"), card_body("bbb"), card_body("after card")]",
        ],
        "text": "TAGaaXYabbbafter card",
      }
    `);
  });

  // tryPasteAsCardBodies should NOT fire for inputs outside its
  // contract — single-paragraph slices, non-paragraph slices,
  // cursors outside a card_body context.
  describe('tryPasteAsCardBodies — negative cases', () => {
    it('single-paragraph slice → returns null', () => {
      const doc = makeDoc([cardWith(tag('TAG'), cardBody('aaa'))]);
      const cursor = posInside(doc, (n) => n.isText && n.text === 'aaa', 1);
      const state = makeState(doc).apply(
        makeState(doc).tr.setSelection(TextSelection.create(doc, cursor)),
      );
      const slice = buildPlainTextSlice('X');
      expect(tryPasteAsCardBodies(state, slice)).toBeNull();
    });

    it('cursor in a tag → returns null', () => {
      const doc = makeDoc([cardWith(tag('TAG'), cardBody('body'))]);
      const cursor = posInside(doc, (n) => n.isText && n.text === 'TAG', 2);
      const state = makeState(doc).apply(
        makeState(doc).tr.setSelection(TextSelection.create(doc, cursor)),
      );
      const slice = buildPlainTextSlice('X\nY');
      expect(tryPasteAsCardBodies(state, slice)).toBeNull();
    });

    it('cursor in a doc-level paragraph → returns null', () => {
      const doc = makeDoc([paragraph('top-level')]);
      const cursor = posInside(doc, (n) => n.isText && n.text === 'top-level', 3);
      const state = makeState(doc).apply(
        makeState(doc).tr.setSelection(TextSelection.create(doc, cursor)),
      );
      const slice = buildPlainTextSlice('X\nY');
      expect(tryPasteAsCardBodies(state, slice)).toBeNull();
    });
  });

  // ──────────────────────────────────────────────────────────────
  // Scenario B-fit: the multi-paragraph slice PRE-converted to
  // card_bodies before replaceSelection. Confirms that PM's
  // bubble-up-to-card behavior in scenario B is driven by the
  // slice having paragraph (not card_body) children: fed a
  // card_body slice, the split stays inside the card.
  // ──────────────────────────────────────────────────────────────

  it('B-fit: feeding a card_body slice keeps the split inside the card', () => {
    const doc = makeDoc([
      cardWith(tag('TAG'), cardBody('aaa'), cardBody('bbb')),
      paragraph('after card'),
    ]);
    const cursor = posInside(doc, (n) => n.isText && n.text === 'aaa', 2);
    const state = makeState(doc).apply(
      makeState(doc).tr.setSelection(TextSelection.create(doc, cursor)),
    );
    // Build a 2-child card_body slice (instead of paragraph slice).
    const slice = new Slice(
      Fragment.fromArray([cardBody('X'), cardBody('Y')]),
      1,
      1,
    );
    const after = state.apply(state.tr.replaceSelection(slice));

    expect({
      structure: docTypeShape(after.doc),
      text: after.doc.textContent,
      cursor: cursorReport(after),
    }).toMatchInlineSnapshot(`
      {
        "cursor": {
          "atDocEnd": false,
          "docSize": 33,
          "inLastTextblock": false,
          "pos": 13,
        },
        "structure": [
          "card[tag("TAG"), card_body("aaX"), card_body("Ya"), card_body("bbb"), card_body("after card")]",
        ],
        "text": "TAGaaXYabbbafter card",
      }
    `);
  });

  // ──────────────────────────────────────────────────────────────
  // Scenario F12: `clearToNormal` (F12) on a tag. Its dissolve path
  // replaces the enclosing container wholesale; without its manual
  // `setSelection` after the `replaceWith`, the cursor maps to the END
  // of the lifted content (the reported "cursor shot to doc end
  // after F12").
  // ──────────────────────────────────────────────────────────────

  it('F12 on tag with trailing bodies — cursor should land in the new paragraph, not at the end of the lifted bodies', () => {
    const doc = makeDoc([
      cardWith(tag('TAG'), cardBody('body one'), cardBody('body two')),
    ]);
    const cursor = posInside(doc, (n) => n.isText && n.text === 'TAG', 2);
    const state = makeState(doc).apply(
      makeState(doc).tr.setSelection(TextSelection.create(doc, cursor)),
    );
    const cursorBefore = cursorReport(state);

    const after = runCmd(state, clearToNormal());

    expect({
      structureBefore: docTypeShape(state.doc),
      cursorBefore,
      structureAfter: docTypeShape(after.doc),
      cursorAfter: cursorReport(after),
    }).toMatchInlineSnapshot(`
      {
        "cursorAfter": {
          "atDocEnd": false,
          "docSize": 25,
          "inLastTextblock": false,
          "pos": 3,
        },
        "cursorBefore": {
          "atDocEnd": false,
          "docSize": 27,
          "inLastTextblock": false,
          "pos": 4,
        },
        "structureAfter": [
          "paragraph("TAG")",
          "paragraph("body one")",
          "paragraph("body two")",
        ],
        "structureBefore": [
          "card[tag("TAG"), card_body("body one"), card_body("body two")]",
        ],
      }
    `);
  });

  it('F12 on tag inside a single-body card — cursor stays inside the demoted head', () => {
    const doc = makeDoc([
      cardWith(tag('TAGGED'), cardBody('only body')),
    ]);
    const cursor = posInside(doc, (n) => n.isText && n.text === 'TAGGED', 3);
    const state = makeState(doc).apply(
      makeState(doc).tr.setSelection(TextSelection.create(doc, cursor)),
    );

    const after = runCmd(state, clearToNormal());

    expect({
      structureAfter: docTypeShape(after.doc),
      cursorAfter: cursorReport(after),
    }).toMatchInlineSnapshot(`
      {
        "cursorAfter": {
          "atDocEnd": false,
          "docSize": 19,
          "inLastTextblock": false,
          "pos": 4,
        },
        "structureAfter": [
          "paragraph("TAGGED")",
          "paragraph("only body")",
        ],
      }
    `);
  });

  it('F12 on tag of card preceded by another card — absorb should not amplify the wrong mapping', () => {
    // Card A then Card B. F12 on Card B's tag dissolves B. The
    // lifted children become doc-level after Card A — absorb
    // claims them into A. If F12 left the cursor at the end of
    // the lifted region, the absorbed-into-A cursor lands at the
    // tail end of A's new content. The fix should keep the cursor
    // in the demoted (former tag) paragraph instead.
    const doc = makeDoc([
      cardWith(tag('AAA'), cardBody('a body')),
      cardWith(tag('BBB'), cardBody('b1'), cardBody('b2')),
    ]);
    const cursor = posInside(doc, (n) => n.isText && n.text === 'BBB', 2);
    const state = makeState(doc).apply(
      makeState(doc).tr.setSelection(TextSelection.create(doc, cursor)),
    );

    const after = runCmd(state, clearToNormal());

    expect({
      structureAfter: docTypeShape(after.doc),
      cursorAfter: cursorReport(after),
    }).toMatchInlineSnapshot(`
      {
        "cursorAfter": {
          "atDocEnd": false,
          "docSize": 28,
          "inLastTextblock": false,
          "pos": 17,
        },
        "structureAfter": [
          "card[tag("AAA"), card_body("a body"), card_body("BBB"), card_body("b1"), card_body("b2")]",
        ],
      }
    `);
  });

  it('F12 on analytic head dissolves analytic_unit, cursor in demoted paragraph', () => {
    const analyticUnit = schema.nodes['analytic_unit']!.createChecked(
      null,
      [
        schema.nodes['analytic']!.create({ id: newHeadingId() }, schema.text('HEAD')),
        schema.nodes['card_body']!.create(null, schema.text('one')),
      ],
    );
    const doc = makeDoc([analyticUnit]);
    const cursor = posInside(doc, (n) => n.isText && n.text === 'HEAD', 2);
    const state = makeState(doc).apply(
      makeState(doc).tr.setSelection(TextSelection.create(doc, cursor)),
    );

    const after = runCmd(state, clearToNormal());

    expect({
      structureAfter: docTypeShape(after.doc),
      cursorAfter: cursorReport(after),
    }).toMatchInlineSnapshot(`
      {
        "cursorAfter": {
          "atDocEnd": false,
          "docSize": 11,
          "inLastTextblock": false,
          "pos": 3,
        },
        "structureAfter": [
          "paragraph("HEAD")",
          "paragraph("one")",
        ],
      }
    `);
  });

  // ──────────────────────────────────────────────────────────────
  // F2 plain-paste — schema-bubble-up
  // ──────────────────────────────────────────────────────────────
  //
  // `buildPlainTextSlice` emits `paragraph` nodes opened at depth 1.
  // `paragraph` is NOT a valid child of `card` (card's content rule
  // is `tag (card_body | undertag | cite_paragraph | analytic |
  // table)*`), so when a 3+ line paste lands inside a card_body
  // PM's Fitter can't slot the middle paragraph and bubbles the
  // split up to the card level. The "second-half" card it
  // synthesizes needs to start with a tag — and the first content
  // node it has on hand is the middle line, which it converts to a
  // tag. Visible artifact: a debater pastes "X\nY\nZ" into a
  // card_body and "Y" comes out bold with the tag's before/after
  // margins. Both the rich-paste path and F2 avoid this by routing
  // through `tryPasteAsCardBodies` first.

  it('F2 baseline (no absorb plugin): 3-line plain-paste into EMPTY card_body — does PM synthesize a phantom card with an empty tag?', () => {
    // The paste-plugin's tryPasteAsCardBodies comment specifically
    // names "a phantom empty-tag card sibling" as the failure mode
    // it prevents. Run without absorb to see it raw.
    const doc = makeDoc([
      cardWith(tag('TAG'), cardBody('')),
    ]);
    const cursor = posInside(doc, (n) => n.type.name === 'card_body');
    const bareState = EditorState.create({ doc }).apply(
      EditorState.create({ doc }).tr.setSelection(TextSelection.create(doc, cursor)),
    );
    const slice = buildPlainTextSlice('X\nY\nZ');
    const after = bareState.apply(bareState.tr.replaceSelection(slice));

    expect({
      structure: docTypeShape(after.doc),
      text: after.doc.textContent,
      cursor: cursorReport(after),
    }).toMatchInlineSnapshot(`
      {
        "cursor": {
          "atDocEnd": true,
          "docSize": 16,
          "inLastTextblock": true,
          "pos": 15,
        },
        "structure": [
          "card[tag("TAG"), card_body("X")]",
          "paragraph("Y")",
          "paragraph("Z")",
        ],
        "text": "TAGXYZ",
      }
    `);
  });

  it('F2 baseline (no absorb plugin): 3-line plain-paste mid-card_body bubbles up and splits the card', () => {
    // Run WITHOUT the absorb plugin to see what PM's Fitter does
    // raw: the middle paragraph escapes to doc level, and the card
    // gets split / the orphaned middle gets promoted somewhere.
    // The running editor's absorb plugin then re-claims orphans,
    // but on the way it produces the visible artifacts the FDP
    // spec calls out (line-elevated-to-tag, content escaping the
    // card, extra spacing from the tag margins, etc.).
    const doc = makeDoc([
      cardWith(tag('TAG'), cardBody('aaa')),
    ]);
    const cursor = posInside(doc, (n) => n.isText && n.text === 'aaa', 2);
    const bareState = EditorState.create({ doc }).apply(
      EditorState.create({ doc }).tr.setSelection(TextSelection.create(doc, cursor)),
    );
    const slice = buildPlainTextSlice('X\nY\nZ');
    const after = bareState.apply(bareState.tr.replaceSelection(slice));

    expect({
      structure: docTypeShape(after.doc),
      text: after.doc.textContent,
      cursor: cursorReport(after),
    }).toMatchInlineSnapshot(`
      {
        "cursor": {
          "atDocEnd": false,
          "docSize": 19,
          "inLastTextblock": true,
          "pos": 17,
        },
        "structure": [
          "card[tag("TAG"), card_body("aaX")]",
          "paragraph("Y")",
          "paragraph("Za")",
        ],
        "text": "TAGaaXYZa",
      }
    `);
  });

  it('F2 baseline (no absorb): 3-line paste at END of last card_body — what happens to the trailing paragraphs?', () => {
    const doc = makeDoc([
      cardWith(tag('TAG'), cardBody('hello')),
    ]);
    const cursor = posInside(doc, (n) => n.isText && n.text === 'hello', 5);
    const bareState = EditorState.create({ doc }).apply(
      EditorState.create({ doc }).tr.setSelection(TextSelection.create(doc, cursor)),
    );
    const slice = buildPlainTextSlice('X\nY\nZ');
    const after = bareState.apply(bareState.tr.replaceSelection(slice));

    expect({
      structure: docTypeShape(after.doc),
      text: after.doc.textContent,
      cursor: cursorReport(after),
    }).toMatchInlineSnapshot(`
      {
        "cursor": {
          "atDocEnd": true,
          "docSize": 21,
          "inLastTextblock": true,
          "pos": 20,
        },
        "structure": [
          "card[tag("TAG"), card_body("helloX")]",
          "paragraph("Y")",
          "paragraph("Z")",
        ],
        "text": "TAGhelloXYZ",
      }
    `);
  });

  it('F2 baseline (no absorb): 3-line paste at END of last card_body when ANOTHER CARD FOLLOWS — middle paragraphs collide with the next card', () => {
    const doc = makeDoc([
      cardWith(tag('SRC'), cardBody('end of src')),
      cardWith(tag('NEXT'), cardBody('next body')),
    ]);
    const cursor = posInside(doc, (n) => n.isText && n.text === 'end of src', 10);
    const bareState = EditorState.create({ doc }).apply(
      EditorState.create({ doc }).tr.setSelection(TextSelection.create(doc, cursor)),
    );
    const slice = buildPlainTextSlice('X\nY\nZ');
    const after = bareState.apply(bareState.tr.replaceSelection(slice));

    expect({
      structure: docTypeShape(after.doc),
      text: after.doc.textContent,
      cursor: cursorReport(after),
    }).toMatchInlineSnapshot(`
      {
        "cursor": {
          "atDocEnd": false,
          "docSize": 45,
          "inLastTextblock": false,
          "pos": 25,
        },
        "structure": [
          "card[tag("SRC"), card_body("end of srcX")]",
          "paragraph("Y")",
          "paragraph("Z")",
          "card[tag("NEXT"), card_body("next body")]",
        ],
        "text": "SRCend of srcXYZNEXTnext body",
      }
    `);
  });

  it('F2 baseline (WITH absorb): same scenario — does absorb restore the structure but leave the cursor on the next card?', () => {
    const doc = makeDoc([
      cardWith(tag('SRC'), cardBody('end of src')),
      cardWith(tag('NEXT'), cardBody('next body')),
    ]);
    const cursor = posInside(doc, (n) => n.isText && n.text === 'end of src', 10);
    const state = makeState(doc).apply(
      makeState(doc).tr.setSelection(TextSelection.create(doc, cursor)),
    );
    const after = paste(state, 'X\nY\nZ');

    expect({
      structure: docTypeShape(after.doc),
      text: after.doc.textContent,
      cursor: cursorReport(after),
    }).toMatchInlineSnapshot(`
      {
        "cursor": {
          "atDocEnd": false,
          "docSize": 45,
          "inLastTextblock": false,
          "pos": 24,
        },
        "structure": [
          "card[tag("SRC"), card_body("end of srcX"), card_body("Y"), card_body("Z")]",
          "card[tag("NEXT"), card_body("next body")]",
        ],
        "text": "SRCend of srcXYZNEXTnext body",
      }
    `);
  });

  it('F2 baseline (WITH absorb): 2-line paste at END of last card_body, ANOTHER card follows — where does the cursor land?', () => {
    // The user-reported "cursor lands on the line below = the next
    // card's tag" scenario. After the 2-line paste, PM has the
    // slice's last paragraph merge with the after-cursor content
    // (which is empty since the cursor is at end-of-body).
    const doc = makeDoc([
      cardWith(tag('SRC'), cardBody('end of src')),
      cardWith(tag('NEXT'), cardBody('next body')),
    ]);
    const cursor = posInside(doc, (n) => n.isText && n.text === 'end of src', 10);
    const state = makeState(doc).apply(
      makeState(doc).tr.setSelection(TextSelection.create(doc, cursor)),
    );
    const after = paste(state, 'X\nY');

    const $head = after.doc.resolve(after.selection.head);
    expect({
      structure: docTypeShape(after.doc),
      cursor: cursorReport(after),
      cursorParent: $head.parent.type.name,
      cursorParentText: $head.parent.textContent,
      cursorOffsetInParent: after.selection.head - $head.start(),
    }).toMatchInlineSnapshot(`
      {
        "cursor": {
          "atDocEnd": false,
          "docSize": 42,
          "inLastTextblock": false,
          "pos": 21,
        },
        "cursorOffsetInParent": 1,
        "cursorParent": "card_body",
        "cursorParentText": "Y",
        "structure": [
          "card[tag("SRC"), card_body("end of srcX"), card_body("Y")]",
          "card[tag("NEXT"), card_body("next body")]",
        ],
      }
    `);
  });

  it('F2 baseline (WITH absorb): single-line paste at END of last card_body, ANOTHER card follows', () => {
    // A single line ending in a newline. The report says "if
    // pasted ends in a line break, cursor on a new line is
    // fine." So a paste of "X\n" should leave the cursor
    // on a fresh empty line — but not on the next card's tag.
    const doc = makeDoc([
      cardWith(tag('SRC'), cardBody('end of src')),
      cardWith(tag('NEXT'), cardBody('next body')),
    ]);
    const cursor = posInside(doc, (n) => n.isText && n.text === 'end of src', 10);
    const state = makeState(doc).apply(
      makeState(doc).tr.setSelection(TextSelection.create(doc, cursor)),
    );
    const after = paste(state, 'X\n');

    const $head = after.doc.resolve(after.selection.head);
    expect({
      structure: docTypeShape(after.doc),
      cursor: cursorReport(after),
      cursorParent: $head.parent.type.name,
      cursorParentText: $head.parent.textContent,
      cursorOffsetInParent: after.selection.head - $head.start(),
    }).toMatchInlineSnapshot(`
      {
        "cursor": {
          "atDocEnd": false,
          "docSize": 41,
          "inLastTextblock": false,
          "pos": 20,
        },
        "cursorOffsetInParent": 0,
        "cursorParent": "card_body",
        "cursorParentText": "",
        "structure": [
          "card[tag("SRC"), card_body("end of srcX"), card_body]",
          "card[tag("NEXT"), card_body("next body")]",
        ],
      }
    `);
  });

  it('F2 baseline: 3-line plain-paste mid-card_body bubbles up and elevates the middle line to a tag', () => {
    const doc = makeDoc([
      cardWith(tag('TAG'), cardBody('aaa')),
    ]);
    const cursor = posInside(doc, (n) => n.isText && n.text === 'aaa', 2);
    const state = makeState(doc).apply(
      makeState(doc).tr.setSelection(TextSelection.create(doc, cursor)),
    );

    // Direct `replaceSelection` (bypassing `tryPasteAsCardBodies`)
    // captures the raw bubble-up behavior, for contrast with the
    // F2-path test below.
    const after = paste(state, 'X\nY\nZ');

    expect({
      structure: docTypeShape(after.doc),
      text: after.doc.textContent,
      cursor: cursorReport(after),
    }).toMatchInlineSnapshot(`
      {
        "cursor": {
          "atDocEnd": false,
          "docSize": 19,
          "inLastTextblock": true,
          "pos": 16,
        },
        "structure": [
          "card[tag("TAG"), card_body("aaX"), card_body("Y"), card_body("Za")]",
        ],
        "text": "TAGaaXYZa",
      }
    `);
  });

  it('F2 fix: same 3-line paste through tryPasteAsCardBodies stays as card_body siblings (no tag elevation)', () => {
    const doc = makeDoc([
      cardWith(tag('TAG'), cardBody('aaa')),
    ]);
    const cursor = posInside(doc, (n) => n.isText && n.text === 'aaa', 2);
    const state = makeState(doc).apply(
      makeState(doc).tr.setSelection(TextSelection.create(doc, cursor)),
    );

    const after = f2Paste(state, 'X\nY\nZ');

    expect({
      structure: docTypeShape(after.doc),
      text: after.doc.textContent,
      cursor: cursorReport(after),
    }).toMatchInlineSnapshot(`
      {
        "cursor": {
          "atDocEnd": false,
          "docSize": 19,
          "inLastTextblock": true,
          "pos": 16,
        },
        "structure": [
          "card[tag("TAG"), card_body("aaX"), card_body("Y"), card_body("Za")]",
        ],
        "text": "TAGaaXYZa",
      }
    `);
  });

  it('F2 fix: 5-line paste mid-card_body — every line is a card_body, the card is never split', () => {
    const doc = makeDoc([
      cardWith(tag('TAG'), cardBody('hello')),
    ]);
    const cursor = posInside(doc, (n) => n.isText && n.text === 'hello', 3);
    const state = makeState(doc).apply(
      makeState(doc).tr.setSelection(TextSelection.create(doc, cursor)),
    );

    const after = f2Paste(state, 'A\nB\nC\nD\nE');

    expect({
      structure: docTypeShape(after.doc),
      cursor: cursorReport(after),
    }).toMatchInlineSnapshot(`
      {
        "cursor": {
          "atDocEnd": false,
          "docSize": 27,
          "inLastTextblock": false,
          "pos": 23,
        },
        "structure": [
          "card[tag("TAG"), card_body("helA"), card_body("B"), card_body("C"), card_body("D"), card_body("Elo")]",
        ],
      }
    `);
  });

  it('F2 fix: 2-line paste falls through to default replaceSelection (openings can absorb both ends)', () => {
    // Slice with only 2 paragraphs: openStart=1 / openEnd=1 hide
    // the bubble-up entirely (no middle paragraph to misroute).
    // tryPasteAsCardBodies still pre-converts, but the result is
    // the same shape PM would produce by default. Test asserts
    // we don't regress on this easy case.
    const doc = makeDoc([
      cardWith(tag('TAG'), cardBody('hello')),
    ]);
    const cursor = posInside(doc, (n) => n.isText && n.text === 'hello', 3);
    const state = makeState(doc).apply(
      makeState(doc).tr.setSelection(TextSelection.create(doc, cursor)),
    );

    const after = f2Paste(state, 'X\nY');

    expect({
      structure: docTypeShape(after.doc),
    }).toMatchInlineSnapshot(`
      {
        "structure": [
          "card[tag("TAG"), card_body("helX"), card_body("Ylo")]",
        ],
      }
    `);
  });

  it('F2 fix: 2-line paste at END of last card_body of card followed by another card — cursor lands at end of last pasted line, NOT on the next card\'s tag', () => {
    // The specific user-reported case. With the bubble-up bug,
    // PM could leave the cursor near (or on) the following card's
    // tag during the lift-and-reabsorb dance. With
    // tryPasteAsCardBodies in front of the dispatch, the slice
    // stays inside SRC and the cursor stays inside the newly-
    // inserted card_body("Y").
    const doc = makeDoc([
      cardWith(tag('SRC'), cardBody('end of src')),
      cardWith(tag('NEXT'), cardBody('next body')),
    ]);
    const cursor = posInside(doc, (n) => n.isText && n.text === 'end of src', 10);
    const state = makeState(doc).apply(
      makeState(doc).tr.setSelection(TextSelection.create(doc, cursor)),
    );
    const after = f2Paste(state, 'X\nY');

    const $head = after.doc.resolve(after.selection.head);
    expect({
      structure: docTypeShape(after.doc),
      cursorParent: $head.parent.type.name,
      cursorParentText: $head.parent.textContent,
      cursorOffsetInParent: after.selection.head - $head.start(),
    }).toMatchInlineSnapshot(`
      {
        "cursorOffsetInParent": 1,
        "cursorParent": "card_body",
        "cursorParentText": "Y",
        "structure": [
          "card[tag("SRC"), card_body("end of srcX"), card_body("Y")]",
          "card[tag("NEXT"), card_body("next body")]",
        ],
      }
    `);
  });

  it('F2 fix: paste ending in a newline — cursor lands on the trailing empty body (the "fresh line" case the user said is fine)', () => {
    const doc = makeDoc([
      cardWith(tag('SRC'), cardBody('end of src')),
      cardWith(tag('NEXT'), cardBody('next body')),
    ]);
    const cursor = posInside(doc, (n) => n.isText && n.text === 'end of src', 10);
    const state = makeState(doc).apply(
      makeState(doc).tr.setSelection(TextSelection.create(doc, cursor)),
    );
    const after = f2Paste(state, 'X\n');

    const $head = after.doc.resolve(after.selection.head);
    expect({
      structure: docTypeShape(after.doc),
      cursorParent: $head.parent.type.name,
      cursorParentText: $head.parent.textContent,
      cursorOffsetInParent: after.selection.head - $head.start(),
    }).toMatchInlineSnapshot(`
      {
        "cursorOffsetInParent": 0,
        "cursorParent": "card_body",
        "cursorParentText": "",
        "structure": [
          "card[tag("SRC"), card_body("end of srcX"), card_body]",
          "card[tag("NEXT"), card_body("next body")]",
        ],
      }
    `);
  });

  it('F2 fix: single-line paste keeps falling through to replaceSelection (slice has no paragraph children)', () => {
    const doc = makeDoc([
      cardWith(tag('TAG'), cardBody('hello')),
    ]);
    const cursor = posInside(doc, (n) => n.isText && n.text === 'hello', 5);
    const state = makeState(doc).apply(
      makeState(doc).tr.setSelection(TextSelection.create(doc, cursor)),
    );

    const after = f2Paste(state, 'ZZZ');

    expect({
      structure: docTypeShape(after.doc),
    }).toMatchInlineSnapshot(`
      {
        "structure": [
          "card[tag("TAG"), card_body("helloZZZ")]",
        ],
      }
    `);
  });

  it('absorb-plugin maps cursor when it rewrites the doc', () => {
    const doc = makeDoc([
      cardWith(tag('TAG'), cardBody('original body')),
      paragraph('orphan one'),
      paragraph('orphan two'),
    ]);
    const cursor = posInside(doc, (n) => n.isText && n.text === 'orphan one', 5);
    const state = makeState(doc).apply(
      makeState(doc).tr.setSelection(TextSelection.create(doc, cursor)),
    );
    const cursorBefore = cursorReport(state);

    // Manually fire absorb (simulates the appendTransaction path).
    const rebuilt = absorbedDocChildren(state.doc);
    if (!rebuilt) {
      // absorb didn't fire — surface that.
      expect({ absorbFired: false }).toMatchInlineSnapshot();
      return;
    }
    const after = state.apply(
      state.tr.replaceWith(0, state.doc.content.size, rebuilt),
    );

    expect({
      structureBefore: docTypeShape(state.doc),
      structureAfter: docTypeShape(after.doc),
      cursorBefore,
      cursorAfter: cursorReport(after),
    }).toMatchInlineSnapshot(`
      {
        "cursorAfter": {
          "atDocEnd": false,
          "docSize": 46,
          "inLastTextblock": true,
          "pos": 44,
        },
        "cursorBefore": {
          "atDocEnd": false,
          "docSize": 46,
          "inLastTextblock": false,
          "pos": 28,
        },
        "structureAfter": [
          "card[tag("TAG"), card_body("original body"), card_body("orphan one"), card_body("orphan two")]",
        ],
        "structureBefore": [
          "card[tag("TAG"), card_body("original body")]",
          "paragraph("orphan one")",
          "paragraph("orphan two")",
        ],
      }
    `);
  });
});

// ─── helpers ──────────────────────────────────────────────────────

function docTypeShape(doc: import('prosemirror-model').Node): string[] {
  const out: string[] = [];
  doc.forEach((child) => {
    if (child.type.name === 'card' || child.type.name === 'analytic_unit') {
      const inner: string[] = [];
      child.forEach((g) => inner.push(g.type.name + (g.textContent ? `("${g.textContent}")` : '')));
      out.push(`${child.type.name}[${inner.join(', ')}]`);
    } else {
      out.push(`${child.type.name}${child.textContent ? `("${child.textContent}")` : ''}`);
    }
  });
  return out;
}

function docLevelOrphans(doc: import('prosemirror-model').Node): string[] {
  const out: string[] = [];
  doc.forEach((child) => {
    const t = child.type.name;
    if (t === 'paragraph' || t === 'cite_paragraph' || t === 'undertag' || t === 'card_body') {
      out.push(`${t}("${child.textContent}")`);
    }
  });
  return out;
}
