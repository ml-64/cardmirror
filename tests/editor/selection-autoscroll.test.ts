import { describe, it, expect } from 'vitest';
import { edgeAutoscrollDelta } from '../../src/editor/word-selection-plugin.js';

// Viewport spanning clientY 100..500, default 44px edge band.
const TOP = 100;
const BOTTOM = 500;

describe('edgeAutoscrollDelta', () => {
  it('is zero in the middle of the viewport', () => {
    expect(edgeAutoscrollDelta(TOP, BOTTOM, 300)).toBe(0);
  });

  it('is zero just outside the edge bands', () => {
    expect(edgeAutoscrollDelta(TOP, BOTTOM, TOP + 44)).toBe(0);
    expect(edgeAutoscrollDelta(TOP, BOTTOM, BOTTOM - 44)).toBe(0);
  });

  it('scrolls up (negative) inside the top band, down (positive) inside the bottom band', () => {
    expect(edgeAutoscrollDelta(TOP, BOTTOM, TOP + 10)).toBeLessThan(0);
    expect(edgeAutoscrollDelta(TOP, BOTTOM, BOTTOM - 10)).toBeGreaterThan(0);
  });

  it('creeps at least 1px the moment the pointer enters the band', () => {
    // Just inside the top band (depth ~0) still nudges by 1px.
    expect(edgeAutoscrollDelta(TOP, BOTTOM, TOP + 43)).toBe(-1);
    expect(edgeAutoscrollDelta(TOP, BOTTOM, BOTTOM - 43)).toBe(1);
  });

  it('ramps to the max step at and beyond the very edge', () => {
    expect(edgeAutoscrollDelta(TOP, BOTTOM, TOP)).toBe(-20); // at the top edge
    expect(edgeAutoscrollDelta(TOP, BOTTOM, TOP - 1000)).toBe(-20); // far above (clamped)
    expect(edgeAutoscrollDelta(TOP, BOTTOM, BOTTOM)).toBe(20); // at the bottom edge
    expect(edgeAutoscrollDelta(TOP, BOTTOM, BOTTOM + 1000)).toBe(20); // far below (clamped)
  });

  it('gets faster the deeper into the band the pointer goes', () => {
    const shallow = Math.abs(edgeAutoscrollDelta(TOP, BOTTOM, BOTTOM - 30));
    const deep = Math.abs(edgeAutoscrollDelta(TOP, BOTTOM, BOTTOM - 5));
    expect(deep).toBeGreaterThan(shallow);
  });
});
