/**
 * Probe tests for the "Copy Last Cite into the wrong slot when
 * cursor is at start of tag" bug.
 *
 * Repro: a multi-paragraph card with a tag but no cite; cursor at
 * the BEGINNING of the card; pressing Alt+F8 (copy previous cite)
 * inserts the cite at the start of the SECOND paragraph of the
 * card. With the cursor at the END of the tag the cite lands in
 * the right place (between tag and first `card_body`).
 */

import { describe, expect, it, afterEach } from 'vitest';
import { EditorState, TextSelection, Selection } from 'prosemirror-state';
import { schema, newHeadingId } from '../../src/schema/index.js';
import { copyPreviousCite } from '../../src/editor/ribbon-commands.js';
import { settings } from '../../src/editor/settings.js';

// Doc builders.
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
function citePara(text: string) {
  return schema.nodes['cite_paragraph']!.create(null, schema.text(text));
}
function makeDoc(children: import('prosemirror-model').Node[]) {
  return schema.nodes['doc']!.createChecked(null, children);
}
function cardWith(...children: import('prosemirror-model').Node[]) {
  return schema.nodes['card']!.createChecked(null, children);
}

function structure(doc: import('prosemirror-model').Node): string[] {
  const out: string[] = [];
  doc.forEach((child) => {
    if (child.type.name === 'card' || child.type.name === 'analytic_unit') {
      const inner: string[] = [];
      child.forEach((g) => inner.push(`${g.type.name}("${g.textContent}")`));
      out.push(`${child.type.name}[${inner.join(', ')}]`);
    } else {
      out.push(`${child.type.name}("${child.textContent}")`);
    }
  });
  return out;
}

/** Build a doc with a "previous" cite-bearing card (so the
 *  command has something to copy) and the target card. */
function buildDocAndSelect(cursorSpec: {
  // What to pass to TextSelection.create as the position.
  targetText?: string;
  offsetInText?: number;
  position?: number;
}) {
  const doc = makeDoc([
    // Source card carrying a cite_paragraph to be copied.
    cardWith(
      tag('SRC TAG'),
      citePara('Source Author 2025, "The Source," Publisher.'),
      cardBody('source body'),
    ),
    // Target card — multi-paragraph card with tag but NO cite.
    cardWith(
      tag('DEST TAG'),
      cardBody('first paragraph'),
      cardBody('second paragraph'),
    ),
  ]);
  let pos: number;
  if (cursorSpec.position !== undefined) {
    pos = cursorSpec.position;
  } else {
    let found = -1;
    doc.descendants((node, p) => {
      if (found !== -1) return false;
      if (node.isText && node.text === cursorSpec.targetText) {
        found = p + (cursorSpec.offsetInText ?? 0);
        return false;
      }
      return true;
    });
    if (found < 0) throw new Error('target text not found');
    pos = found;
  }
  const state = EditorState.create({ doc });
  return state.apply(state.tr.setSelection(TextSelection.create(state.doc, pos)));
}

function runCmd(state: EditorState): EditorState {
  let after: EditorState | null = null;
  copyPreviousCite()(state, (tr) => { after = state.apply(tr); });
  if (!after) throw new Error('copyPreviousCite did not dispatch');
  // Cast: TS's flow analysis narrows `after` to `never` after the
  // throw because it doesn't track the closure mutation above.
  return after as EditorState;
}

describe('Copy Last Cite — placement when cursor is in the destination tag', () => {
  // ─── Cursor at END of DEST tag (the working case) ───
  it('cursor at END of "DEST TAG" → cite goes between tag and first card_body', () => {
    const state = buildDocAndSelect({ targetText: 'DEST TAG', offsetInText: 8 });
    const after = runCmd(state);
    expect(structure(after.doc)).toMatchInlineSnapshot(`
      [
        "card[tag("SRC TAG"), cite_paragraph("Source Author 2025, "The Source," Publisher."), card_body("source body")]",
        "card[tag("DEST TAG"), cite_paragraph("Source Author 2025, "The Source," Publisher."), card_body("first paragraph"), card_body("second paragraph")]",
      ]
    `);
  });

  // ─── Cursor at START of DEST tag (the reported bug) ───
  it('cursor at START of "DEST TAG" (offset 0 in tag text) → cite goes where?', () => {
    const state = buildDocAndSelect({ targetText: 'DEST TAG', offsetInText: 0 });
    const after = runCmd(state);
    expect(structure(after.doc)).toMatchInlineSnapshot(`
      [
        "card[tag("SRC TAG"), cite_paragraph("Source Author 2025, "The Source," Publisher."), card_body("source body")]",
        "card[tag("DEST TAG"), cite_paragraph("Source Author 2025, "The Source," Publisher."), card_body("first paragraph"), card_body("second paragraph")]",
      ]
    `);
  });

  // ─── Cursor "before tag" — the card-open boundary position ───
  //
  // This is the position you'd land at if you clicked at the very
  // start of the card (above the tag text). PM resolves this as
  // a position INSIDE the card at offset 0, BEFORE the tag.
  // `parent` is the card, not the tag.
  it('cursor at card-open boundary (parent = card) → cite goes where?', () => {
    // Doc position 0 is BEFORE the source card.
    // Position right after card 1 = source card's end.
    // We want the DEST card's "just inside card-open" position.
    const doc = buildDocAndSelect({ position: 0 }).doc;
    // Compute: source card size, then dest card open boundary.
    const srcCard = doc.firstChild!;
    const destCardOpenInside = srcCard.nodeSize + 1; // just inside dest card-open
    const state = buildDocAndSelect({ position: destCardOpenInside });
    const after = runCmd(state);
    expect(structure(after.doc)).toMatchInlineSnapshot(`
      [
        "card[tag("SRC TAG"), cite_paragraph("Source Author 2025, "The Source," Publisher."), card_body("source body")]",
        "card[tag("DEST TAG"), card_body("first paragraph"), card_body("second paragraph")]",
        "cite_paragraph("Source Author 2025, "The Source," Publisher.")",
      ]
    `);
  });

  // ─── Cursor at START (offset 0) of first card_body — THE BUG ───
  it('cursor at START of first card_body (offset 0) → cite between tag and first body', () => {
    const state = buildDocAndSelect({ targetText: 'first paragraph', offsetInText: 0 });
    const after = runCmd(state);
    expect(structure(after.doc)).toMatchInlineSnapshot(`
      [
        "card[tag("SRC TAG"), cite_paragraph("Source Author 2025, "The Source," Publisher."), card_body("source body")]",
        "card[tag("DEST TAG"), cite_paragraph("Source Author 2025, "The Source," Publisher."), card_body("first paragraph"), card_body("second paragraph")]",
      ]
    `);
  });

  // ─── Cursor MID first card_body — still goes AFTER the body ───
  it('cursor MID first card_body (offset 5) → cite between body 1 and body 2', () => {
    const state = buildDocAndSelect({ targetText: 'first paragraph', offsetInText: 5 });
    const after = runCmd(state);
    expect(structure(after.doc)).toMatchInlineSnapshot(`
      [
        "card[tag("SRC TAG"), cite_paragraph("Source Author 2025, "The Source," Publisher."), card_body("source body")]",
        "card[tag("DEST TAG"), card_body("first paragraph"), cite_paragraph("Source Author 2025, "The Source," Publisher."), card_body("second paragraph")]",
      ]
    `);
  });

  // ─── Cursor at START (offset 0) of SECOND card_body ───
  it('cursor at START of second card_body (offset 0) → cite between body 1 and body 2', () => {
    const state = buildDocAndSelect({ targetText: 'second paragraph', offsetInText: 0 });
    const after = runCmd(state);
    expect(structure(after.doc)).toMatchInlineSnapshot(`
      [
        "card[tag("SRC TAG"), cite_paragraph("Source Author 2025, "The Source," Publisher."), card_body("source body")]",
        "card[tag("DEST TAG"), card_body("first paragraph"), cite_paragraph("Source Author 2025, "The Source," Publisher."), card_body("second paragraph")]",
      ]
    `);
  });

  // ─── Cursor in SECOND card_body of DEST card ───
  it('cursor in second card_body of DEST card → cite goes where?', () => {
    const state = buildDocAndSelect({ targetText: 'second paragraph', offsetInText: 5 });
    const after = runCmd(state);
    expect(structure(after.doc)).toMatchInlineSnapshot(`
      [
        "card[tag("SRC TAG"), cite_paragraph("Source Author 2025, "The Source," Publisher."), card_body("source body")]",
        "card[tag("DEST TAG"), card_body("first paragraph"), card_body("second paragraph"), cite_paragraph("Source Author 2025, "The Source," Publisher.")]",
      ]
    `);
  });
});

describe('Copy Previous Cite — nearest-only setting', () => {
  afterEach(() => settings.set('copyPreviousCiteNearestOnly', false));

  /** Source card with TWO cites, destination card with none. */
  function twoCiteDocAndSelect(): EditorState {
    const doc = makeDoc([
      cardWith(
        tag('SRC TAG'),
        citePara('First Author 2024.'),
        citePara('Second Author 2025.'),
        cardBody('source body'),
      ),
      cardWith(tag('DEST TAG'), cardBody('dest body')),
    ]);
    let pos = -1;
    doc.descendants((node, p) => {
      if (pos !== -1) return false;
      if (node.isText && node.text === 'DEST TAG') {
        pos = p + 8; // end of the tag text
        return false;
      }
      return true;
    });
    const state = EditorState.create({ doc });
    return state.apply(state.tr.setSelection(TextSelection.create(state.doc, pos)));
  }

  it('OFF (default): copies the whole cite group of the source', () => {
    const after = runCmd(twoCiteDocAndSelect());
    expect(structure(after.doc)[1]).toBe(
      'card[tag("DEST TAG"), cite_paragraph("First Author 2024."), cite_paragraph("Second Author 2025."), card_body("dest body")]',
    );
  });

  it('ON: copies only the nearest (last) cite of the group', () => {
    settings.set('copyPreviousCiteNearestOnly', true);
    const after = runCmd(twoCiteDocAndSelect());
    expect(structure(after.doc)[1]).toBe(
      'card[tag("DEST TAG"), cite_paragraph("Second Author 2025."), card_body("dest body")]',
    );
  });

  it('ON, phase 1 (cites in the cursor\'s OWN card): nearest preceding wins', () => {
    settings.set('copyPreviousCiteNearestOnly', true);
    const doc = makeDoc([
      cardWith(
        tag('TAG'),
        citePara('Old Cite.'),
        citePara('New Cite.'),
        cardBody('body text here'),
      ),
    ]);
    let pos = -1;
    doc.descendants((node, p) => {
      if (pos !== -1) return false;
      if (node.isText && node.text === 'body text here') {
        pos = p + 14; // end of the body
        return false;
      }
      return true;
    });
    const state0 = EditorState.create({ doc });
    const state = state0.apply(state0.tr.setSelection(TextSelection.create(state0.doc, pos)));
    const after = runCmd(state);
    // The inserted copy (after the body) is "New Cite." — the nearest one.
    expect(structure(after.doc)[0]).toBe(
      'card[tag("TAG"), cite_paragraph("Old Cite."), cite_paragraph("New Cite."), card_body("body text here"), cite_paragraph("New Cite.")]',
    );
  });
});
