/**
 * Modal overlay stack — only the topmost (most recently opened) overlay is
 * "top", which is what each overlay's Escape handler guards on so a stacked
 * dialog doesn't collapse the whole stack on one Escape.
 */
import { describe, it, expect } from 'vitest';
import { pushOverlay, popOverlay, isTopOverlay } from '../../src/editor/overlay-stack.js';

describe('overlay stack', () => {
  it('tracks the most recently opened overlay as the top', () => {
    const a = pushOverlay();
    expect(isTopOverlay(a)).toBe(true);

    const b = pushOverlay();
    expect(isTopOverlay(b)).toBe(true);
    expect(isTopOverlay(a)).toBe(false); // a is no longer top while b is open

    popOverlay(b);
    expect(isTopOverlay(a)).toBe(true); // a is top again

    popOverlay(a);
    expect(isTopOverlay(a)).toBe(false);
  });

  it('pops by token (not just the top) and tolerates unknown/double pops', () => {
    const a = pushOverlay();
    const b = pushOverlay();
    popOverlay(a); // remove the one underneath
    expect(isTopOverlay(b)).toBe(true);
    popOverlay(b);
    popOverlay(b); // double-pop is a no-op
    expect(isTopOverlay(b)).toBe(false);
  });
});
