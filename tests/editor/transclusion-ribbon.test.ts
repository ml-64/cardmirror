// @vitest-environment jsdom
/**
 * Structural ribbon commands (F4–F7 / Mod-F7) inside a live zone.
 *
 * A `transclusion_ref` is a mini-doc (same BLOCK_CONTENT), one level deeper than
 * the doc root. The commands measure depth relative to `structuralBaseDepth`, so
 * they operate INSIDE the zone — new cards/headings land within it — instead of
 * silently no-opping (their old absolute `depth === 1/2` gates never matched a
 * level deeper). The doc-level behavior is covered by ribbon-commands.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { EditorState, TextSelection } from 'prosemirror-state';
import { Fragment, type Node as PMNode } from 'prosemirror-model';
import type { Command as PMCommand } from 'prosemirror-state';
import { schema, newHeadingId } from '../../src/schema/index.js';
import { createTransclusionNode, contentHash, isTransclusionNode } from '../../src/editor/transclusion.js';
import { setTag, setHeading, setAnalytic } from '../../src/editor/ribbon-commands.js';

function card(tag: string, body: string): PMNode {
  return schema.nodes['card']!.createChecked(null, [
    schema.nodes['tag']!.create({ id: newHeadingId() }, schema.text(tag)),
    schema.nodes['card_body']!.create(null, schema.text(body)),
  ]);
}
function zone(children: PMNode[]): PMNode {
  const content = Fragment.fromArray(children);
  return createTransclusionNode(schema, { source_content_hash: contentHash(content) }, content);
}
function docOf(...blocks: PMNode[]): PMNode {
  return schema.nodes['doc']!.createChecked(null, blocks);
}
/** First text position matching `needle` (cursor sits just inside it). */
function posOf(doc: PMNode, needle: string): number {
  let pos = -1;
  doc.descendants((n, p) => {
    if (pos < 0 && n.isText && n.text?.includes(needle)) pos = p + 1;
    return true;
  });
  return pos;
}
/** Run a command with the cursor at `pos`; return the resulting doc. */
function run(doc: PMNode, pos: number, cmd: PMCommand): PMNode {
  const state = EditorState.create({ doc, selection: TextSelection.create(doc, pos) });
  let outDoc = doc;
  const ok = cmd(state, (tr) => {
    outDoc = state.apply(tr).doc;
  });
  expect(ok, 'command should handle the key inside a zone').toBe(true);
  return outDoc;
}
/** The single zone node in a doc + its direct-child type names. */
function zoneChildren(doc: PMNode): string[] {
  let names: string[] = [];
  doc.descendants((n) => {
    if (isTransclusionNode(n)) {
      const out: string[] = [];
      n.forEach((c) => out.push(c.type.name));
      names = out;
      return false;
    }
    return true;
  });
  return names;
}

describe('ribbon structural commands inside a live zone', () => {
  it('F7 (setTag) on a card body splits into a NEW card — inside the zone', () => {
    const doc = docOf(zone([card('First', 'splitme')]));
    const after = run(doc, posOf(doc, 'splitme'), setTag());
    // The zone now holds two cards (original + the body promoted to a new card),
    // and nothing leaked out to the doc level.
    expect(zoneChildren(after)).toEqual(['card', 'card']);
    expect(after.childCount).toBe(1); // still just the zone at doc level
    // The new card carries the split-off text.
    expect(after.textContent).toContain('splitme');
  });

  it('F6 (setHeading block) converts a loose paragraph in the zone in place', () => {
    const doc = docOf(zone([schema.nodes['paragraph']!.create(null, schema.text('lead in'))]));
    const after = run(doc, posOf(doc, 'lead in'), setHeading('block'));
    expect(zoneChildren(after)).toEqual(['block']);
    expect(after.childCount).toBe(1);
  });

  it('Mod-F7 (setAnalytic) wraps a loose paragraph into an analytic_unit in the zone', () => {
    const doc = docOf(zone([schema.nodes['paragraph']!.create(null, schema.text('an analytic'))]));
    const after = run(doc, posOf(doc, 'an analytic'), setAnalytic());
    expect(zoneChildren(after)).toEqual(['analytic_unit']);
    expect(after.childCount).toBe(1);
  });

  it('F7 on a doc-level paragraph still wraps at doc level (base 0 unchanged)', () => {
    const doc = docOf(schema.nodes['paragraph']!.create(null, schema.text('plain')));
    const after = run(doc, posOf(doc, 'plain'), setTag());
    expect(after.child(0).type.name).toBe('card');
  });
});

describe('zone heading-level ceiling (no heading higher than the zone contains)', () => {
  function blockTopped(): PMNode {
    return docOf(
      zone([
        schema.nodes['block']!.create({ id: newHeadingId() }, schema.text('Blk')),
        card('T', 'body'),
      ]),
    );
  }

  it('blocks a higher-rank heading (F5 hat inside a block-topped zone) — no change', () => {
    const doc = blockTopped();
    const before = zoneChildren(doc);
    const after = run(doc, posOf(doc, 'body'), setHeading('hat'));
    expect(zoneChildren(after)).toEqual(before);
  });

  it('blocks a sibling block (F6) in a block-topped zone — no change', () => {
    const doc = blockTopped();
    const before = zoneChildren(doc);
    const after = run(doc, posOf(doc, 'body'), setHeading('block'));
    expect(zoneChildren(after)).toEqual(before);
  });

  it('allows a card (F7) in a block-topped zone', () => {
    const doc = blockTopped();
    const after = run(doc, posOf(doc, 'body'), setTag());
    expect(zoneChildren(after).filter((t) => t === 'card').length).toBe(2);
  });

  it('allows a block inside a pocket-topped zone (legitimate sub-structure)', () => {
    const doc = docOf(
      zone([
        schema.nodes['pocket']!.create({ id: newHeadingId() }, schema.text('Pkt')),
        schema.nodes['paragraph']!.create(null, schema.text('para')),
      ]),
    );
    const after = run(doc, posOf(doc, 'para'), setHeading('block'));
    expect(zoneChildren(after)).toContain('block');
  });
});
