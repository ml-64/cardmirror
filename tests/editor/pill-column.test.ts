/**
 * packColumn — the spacing math behind the "Thinking…" pill queue. Pills
 * must never overlap, whether their targets are scrolled off an edge or
 * sitting near it (the "sweet spot" where clamped targets collide).
 */

import { describe, it, expect } from 'vitest';
import { packColumn } from '../../src/editor/ai/thinking-tooltip.js';

const BAND_TOP = 100;
const FLOOR = 700;
const GAP = 6;
const H = 30;

/** Assert no two pills overlap (each sits at least `gap` below the one above). */
function expectNoOverlap(tops: number[], h: number, gap: number) {
  const sorted = [...tops].sort((a, b) => a - b);
  for (let i = 1; i < sorted.length; i++) {
    expect(sorted[i]! - sorted[i - 1]!).toBeGreaterThanOrEqual(h + gap - 0.001);
  }
}

describe('packColumn', () => {
  it('leaves a single pill at its desired top', () => {
    const tops = packColumn([{ h: H, desired: 300 }], BAND_TOP, FLOOR, GAP);
    expect(tops).toEqual([300]);
  });

  it('queues pills clustered at the top edge downward, no overlap', () => {
    // All targets off the top → desired = bandTop.
    const items = [0, 1, 2, 3].map(() => ({ h: H, desired: BAND_TOP }));
    const tops = packColumn(items, BAND_TOP, FLOOR, GAP);
    expect(tops[0]).toBe(BAND_TOP);
    expectNoOverlap(tops, H, GAP);
    // Stacked strictly downward in order.
    expect(tops).toEqual([100, 136, 172, 208]);
  });

  it('queues pills clustered at the bottom edge upward, no overlap', () => {
    // All targets off the bottom → desired = floor - h.
    const items = [0, 1, 2].map(() => ({ h: H, desired: FLOOR - H }));
    const tops = packColumn(items, BAND_TOP, FLOOR, GAP);
    // The lowest pill ends exactly at the floor; the rest stack upward.
    expect(Math.max(...tops) + H).toBe(FLOOR);
    expectNoOverlap(tops, H, GAP);
  });

  it('separates two in-band pills whose targets sit near the top edge', () => {
    // The "sweet spot": both targets visible but close to the top, so both
    // want the same clamped top. They must not land on the same spot.
    const items = [
      { h: H, desired: BAND_TOP },
      { h: H, desired: BAND_TOP + 4 },
    ];
    const tops = packColumn(items, BAND_TOP, FLOOR, GAP);
    expectNoOverlap(tops, H, GAP);
  });

  it('keeps spread-out in-band pills at their anchors', () => {
    const items = [
      { h: H, desired: 200 },
      { h: H, desired: 400 },
      { h: H, desired: 600 },
    ];
    const tops = packColumn(items, BAND_TOP, FLOOR, GAP);
    expect(tops).toEqual([200, 400, 600]);
  });

  it('returns tops in input order regardless of desired order', () => {
    const items = [
      { h: H, desired: 600 },
      { h: H, desired: 200 },
      { h: H, desired: 400 },
    ];
    const tops = packColumn(items, BAND_TOP, FLOOR, GAP);
    expect(tops).toEqual([600, 200, 400]);
  });

  it('never pushes a pill above the top edge even when overcrowded', () => {
    // More pills than the band can hold → clamp to the band, still ordered.
    const items = Array.from({ length: 40 }, () => ({ h: H, desired: FLOOR - H }));
    const tops = packColumn(items, BAND_TOP, FLOOR, GAP);
    for (const t of tops) expect(t).toBeGreaterThanOrEqual(BAND_TOP);
  });
});
