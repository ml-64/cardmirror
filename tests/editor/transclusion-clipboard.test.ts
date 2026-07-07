/**
 * Clipboard handling for live zones: a same-document paste keeps the live link;
 * a cross-document paste unwraps the zone to its cached cards (a plain paste),
 * since the doc-relative source_ref can't be trusted in the new location.
 */
import { describe, expect, it } from 'vitest';
import { Fragment, Node as PMNode } from 'prosemirror-model';
import { schema, newHeadingId } from '../../src/schema/index.js';
import {
  createTransclusionNode,
  contentHash,
  stampZoneOrigins,
  resolvePastedZones,
  fragmentHasZone,
  isTransclusionNode,
} from '../../src/editor/transclusion.js';

function card(tag: string, body: string): PMNode {
  return schema.nodes['card']!.createChecked(null, [
    schema.nodes['tag']!.create({ id: newHeadingId() }, schema.text(tag)),
    schema.nodes['card_body']!.create(null, schema.text(body)),
  ]);
}
function zone(children: PMNode[]): PMNode {
  const content = Fragment.fromArray(children);
  return createTransclusionNode(
    schema,
    { source_ref: 'S.cmir', source_ref_base: 'doc', source_heading_id: 'H', source_content_hash: contentHash(content) },
    content,
  );
}
function count(frag: Fragment): { zones: number; cards: number } {
  let zones = 0;
  let cards = 0;
  const walk = (n: PMNode): void => {
    if (isTransclusionNode(n)) zones++;
    if (n.type.name === 'card') cards++;
    n.content.forEach(walk);
  };
  frag.forEach(walk);
  return { zones, cards };
}

describe('clipboard live-zone handling', () => {
  it('fragmentHasZone detects a zone (and its absence)', () => {
    expect(fragmentHasZone(Fragment.fromArray([zone([card('A', 'a')])]))).toBe(true);
    expect(fragmentHasZone(Fragment.fromArray([card('A', 'a')]))).toBe(false);
  });

  it('stampZoneOrigins stamps every zone at any depth', () => {
    const frag = Fragment.fromArray([zone([card('A', 'a')])]);
    const stamped = stampZoneOrigins(frag, '/lib/Aff/Doc.cmir');
    expect(String(stamped.child(0).attrs['source_origin'])).toBe('/lib/Aff/Doc.cmir');
  });

  it('same-doc paste keeps the live zone and clears the transient stamp', () => {
    const stamped = stampZoneOrigins(Fragment.fromArray([zone([card('A', 'a')])]), '/lib/Doc.cmir');
    const out = resolvePastedZones(stamped, '/lib/Doc.cmir');
    expect(count(out)).toEqual({ zones: 1, cards: 1 });
    const z = out.child(0);
    expect(String(z.attrs['source_ref'])).toBe('S.cmir');   // link intact
    expect(String(z.attrs['source_origin'])).toBe('');       // stamp cleared
  });

  it('cross-doc paste unwraps the zone to plain cards (no link left)', () => {
    const stamped = stampZoneOrigins(
      Fragment.fromArray([zone([card('A', 'a'), card('B', 'b')])]),
      '/lib/Aff/Doc.cmir',
    );
    const out = resolvePastedZones(stamped, '/lib/Neg/Other.cmir');
    expect(count(out)).toEqual({ zones: 0, cards: 2 }); // frozen snapshot, no zone
    const text = out.textBetween(0, out.size, ' ');
    expect(text).toContain('a');
    expect(text).toContain('b');
  });

  it('an unstamped (unknown-origin) zone also unwraps on paste', () => {
    const out = resolvePastedZones(Fragment.fromArray([zone([card('A', 'a')])]), '/lib/Doc.cmir');
    expect(count(out)).toEqual({ zones: 0, cards: 1 });
  });
});
