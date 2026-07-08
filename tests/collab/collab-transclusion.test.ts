// @vitest-environment jsdom
/**
 * Live-zone + co-editing convergence experiment.
 *
 * The empty-zone reaper (transclusionEmptyZoneReaper) removes a zone the moment
 * a LOCAL edit leaves it empty. Under co-editing the worry is divergence: two
 * Loro-CRDT peers reaping (or not) out of step, or an empty zone that appears
 * only from the MERGE of two peers' edits — a state neither peer's local edit
 * produced, so neither local reaper fired. These tests drive those cases and
 * assert the peers still converge to an identical, schema-valid doc.
 */
import { describe, it, expect } from 'vitest';
import { Fragment, type Node as PMNode } from 'prosemirror-model';
import { schema } from '../../src/schema/index.js';
import {
  createLoroPeers,
  syncAll,
  settle,
  docOf,
  para,
  cardNode,
  typeAfter,
  docText,
  type LoroPeer,
} from './_loro-helpers.js';
import { createTransclusionNode, isTransclusionNode } from '../../src/editor/transclusion.js';
import { transclusionEmptyZoneReaper } from '../../src/editor/transclusion-selection-guard.js';

function zoneOf(cards: PMNode[]): PMNode {
  return createTransclusionNode(
    schema,
    { source_ref: 'S.cmir', source_ref_base: 'doc', source_heading_id: 'H' },
    Fragment.fromArray(cards),
  );
}
const withReaper = () => [transclusionEmptyZoneReaper];

function countZones(d: PMNode): number {
  let z = 0;
  d.descendants((n) => {
    if (isTransclusionNode(n)) z++;
    return true;
  });
  return z;
}
function zonePos(d: PMNode): number {
  let pos = -1;
  d.forEach((n, off) => {
    if (pos < 0 && isTransclusionNode(n)) pos = off;
  });
  return pos;
}
/** Delete the whole inner content of the (single) zone → an empty zone. */
function emptyZone(peer: LoroPeer): void {
  const zp = zonePos(peer.doc());
  const zn = peer.doc().nodeAt(zp)!;
  peer.view.dispatch(peer.view.state.tr.delete(zp + 1, zp + zn.nodeSize - 1));
}
/** Delete the whole card whose tag text contains `tagText`. */
function deleteCardByTag(peer: LoroPeer, tagText: string): void {
  let from = -1;
  let to = -1;
  peer.doc().descendants((n, pos) => {
    if (from >= 0) return false;
    if (n.type.name === 'card' && n.textContent.includes(tagText)) {
      from = pos;
      to = pos + n.nodeSize;
      return false;
    }
    return true;
  });
  if (from < 0) throw new Error(`card not found: ${tagText}`);
  peer.view.dispatch(peer.view.state.tr.delete(from, to));
}
/** The convergence contract every scenario must satisfy. */
function expectConverged(a: LoroPeer, b: LoroPeer): void {
  expect(a.doc().eq(b.doc())).toBe(true); // byte-identical docs
  expect(() => a.doc().check()).not.toThrow(); // schema-valid (no torn zone)
}
/** Any surviving zone with zero content — the phantom we're hunting. */
function hasEmptyZone(d: PMNode): boolean {
  let bad = false;
  d.descendants((n) => {
    if (isTransclusionNode(n) && n.content.size === 0) bad = true;
    return true;
  });
  return bad;
}

describe('live zones under co-editing (Loro CRDT)', () => {
  it('one peer empties a zone while the other edits elsewhere → converge, zone reaped', async () => {
    const seed = docOf(
      para('intro'),
      zoneOf([cardNode('A', ['aaa']), cardNode('B', ['bbb'])]),
      para('outro'),
    );
    const [a, b] = (await createLoroPeers(seed, 2, withReaper)) as [LoroPeer, LoroPeer];
    expect(countZones(a.doc())).toBe(1);

    emptyZone(a); // reaper removes the zone on A
    await settle();
    expect(countZones(a.doc())).toBe(0);
    typeAfter(b.view, 'outro', ' EDIT'); // B edits far from the zone, concurrently

    await syncAll([a, b]);
    expectConverged(a, b);
    expect(countZones(a.doc())).toBe(0); // gone on both
    expect(docText(a.doc())).toContain('EDIT'); // B's edit survived
    a.destroy();
    b.destroy();
  });

  it('concurrent in-zone edits from both peers converge with the zone intact', async () => {
    const seed = docOf(zoneOf([cardNode('A', ['aaa']), cardNode('B', ['bbb'])]));
    const [a, b] = (await createLoroPeers(seed, 2, withReaper)) as [LoroPeer, LoroPeer];

    typeAfter(a.view, 'aaa', 'A1');
    typeAfter(b.view, 'bbb', 'B1');

    await syncAll([a, b]);
    expectConverged(a, b);
    expect(countZones(a.doc())).toBe(1); // never reaped — it kept content throughout
    const t = docText(a.doc());
    expect(t).toContain('aaaA1');
    expect(t).toContain('bbbB1');
    a.destroy();
    b.destroy();
  });

  it('both peers emptying the SAME zone concurrently converge without error', async () => {
    const seed = docOf(para('x'), zoneOf([cardNode('A', ['aaa'])]));
    const [a, b] = (await createLoroPeers(seed, 2, withReaper)) as [LoroPeer, LoroPeer];

    emptyZone(a);
    emptyZone(b);
    await settle();

    await syncAll([a, b]);
    expectConverged(a, b);
    expect(countZones(a.doc())).toBe(0);
    a.destroy();
    b.destroy();
  });

  it('a zone emptied ONLY by the merge of two deletions must not diverge or leave a phantom', async () => {
    // A deletes card A (zone still holds B → no local reap); B deletes card B
    // (zone still holds A → no local reap). The zone is empty only AFTER merge —
    // a state neither peer's local edit produced.
    const seed = docOf(zoneOf([cardNode('A', ['aaa']), cardNode('B', ['bbb'])]));
    const [a, b] = (await createLoroPeers(seed, 2, withReaper)) as [LoroPeer, LoroPeer];

    deleteCardByTag(a, 'A');
    deleteCardByTag(b, 'B');
    await settle();
    expect(countZones(a.doc())).toBe(1); // neither reaped locally
    expect(countZones(b.doc())).toBe(1);

    await syncAll([a, b]);
    expectConverged(a, b); // the hard requirement: identical + valid
    // And the phantom should not survive the merge.
    expect(countZones(a.doc())).toBe(0);
    a.destroy();
    b.destroy();
  });

  it('reap-vs-edit race: A empties the zone while B edits inside it → converge, no husk', async () => {
    const seed = docOf(zoneOf([cardNode('A', ['aaa']), cardNode('B', ['bbb'])]));
    const [a, b] = (await createLoroPeers(seed, 2, withReaper)) as [LoroPeer, LoroPeer];

    emptyZone(a); // A: reaper removes the whole zone
    await settle();
    typeAfter(b.view, 'aaa', 'B-EDIT'); // B: concurrently edits a card inside the zone

    await syncAll([a, b]);
    expectConverged(a, b);
    // Whatever the CRDT keeps (edit may resurrect a card, or the delete may win),
    // it must never be an EMPTY zone shell.
    expect(hasEmptyZone(a.doc())).toBe(false);
    a.destroy();
    b.destroy();
  });

  it('three peers: one empties the zone, two edit elsewhere → all converge', async () => {
    const seed = docOf(para('top'), zoneOf([cardNode('A', ['aaa'])]), para('bottom'));
    const [a, b, c] = (await createLoroPeers(seed, 3, withReaper)) as [LoroPeer, LoroPeer, LoroPeer];

    emptyZone(a);
    await settle();
    typeAfter(b.view, 'top', 'B1');
    typeAfter(c.view, 'bottom', 'C1');

    await syncAll([a, b, c]);
    expect(a.doc().eq(b.doc())).toBe(true);
    expect(b.doc().eq(c.doc())).toBe(true);
    expect(() => a.doc().check()).not.toThrow();
    expect(countZones(a.doc())).toBe(0);
    expect(docText(a.doc())).toContain('B1');
    expect(docText(a.doc())).toContain('C1');
    a.destroy();
    b.destroy();
    c.destroy();
  });

  it('converges under staggered, asymmetric sync order (not just all-pairs flush)', async () => {
    const seed = docOf(zoneOf([cardNode('A', ['aaa']), cardNode('B', ['bbb'])]));
    const [a, b] = (await createLoroPeers(seed, 2, withReaper)) as [LoroPeer, LoroPeer];

    deleteCardByTag(a, 'A'); // merge will empty the zone
    deleteCardByTag(b, 'B');
    await settle();

    // Hand the updates across one direction at a time, reaping between hops.
    b.import(a.exportAll());
    await settle();
    a.import(b.exportAll());
    await settle();
    b.import(a.exportAll());
    await settle();

    expectConverged(a, b);
    expect(hasEmptyZone(a.doc())).toBe(false);
    a.destroy();
    b.destroy();
  });
});
