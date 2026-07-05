/**
 * Scroll-anchoring across a layout change (read-mode toggle / zoom).
 *
 * jsdom has no layout engine, so `coordsAtPos` / `posAtCoords` / real
 * scroll geometry can't be exercised. Instead we test the correction
 * math directly (a pure function) and drive `restoreViewportAnchor` with
 * a stubbed view + scroller whose geometry we script — which lets us both
 * MEASURE the drift a naive toggle leaves behind and prove the restore
 * cancels it.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import type { EditorView } from 'prosemirror-view';
import type { Node as PMNode } from 'prosemirror-model';
import { schema } from '../../src/schema/index.js';
import { firstReadKeptPos, nearestReadKeptPos } from '../../src/editor/read-mode-plugin.js';
import {
  anchoredScrollTop,
  restoreViewportAnchor,
  type ViewportAnchor,
} from '../../src/editor/scroll-anchor.js';

afterEach(() => vi.unstubAllGlobals());

describe('anchoredScrollTop (correction math)', () => {
  it('no drift → no scroll change', () => {
    expect(anchoredScrollTop(500, 300, 300)).toBe(500);
  });
  it('anchor rose by 120px → scroll up 120 to pull it back down', () => {
    // topAfter (180) < topBefore (300): content moved up, so raise scrollTop.
    expect(anchoredScrollTop(500, 300, 180)).toBe(380);
  });
  it('anchor fell by 40px → scroll down 40', () => {
    expect(anchoredScrollTop(200, 50, 90)).toBe(240);
  });
});

/** A view/scroller pair whose anchor sits at a fixed document y; its
 *  viewport y is `docY - scrollTop + layoutShift`, so `layoutShift`
 *  models "the toggle moved everything above the anchor by this much". */
function makeScriptedAnchor(opts: { docY: number; scrollTop: number }) {
  const scroller = { scrollTop: opts.scrollTop } as unknown as HTMLElement;
  let layoutShift = 0;
  const view = {
    dom: { isConnected: true },
    coordsAtPos: () => ({
      top: opts.docY - (scroller as { scrollTop: number }).scrollTop + layoutShift,
      bottom: 0,
      left: 0,
      right: 0,
    }),
  } as unknown as EditorView;
  const topBefore = opts.docY - opts.scrollTop; // layoutShift 0 at capture
  const anchor: ViewportAnchor = { view, scroller, pos: 42, topBefore };
  const anchorViewportTop = () =>
    opts.docY - (scroller as { scrollTop: number }).scrollTop + layoutShift;
  return {
    anchor,
    scroller: scroller as unknown as { scrollTop: number },
    setLayoutShift: (v: number) => (layoutShift = v),
    anchorViewportTop,
    topBefore,
  };
}

describe('restoreViewportAnchor (drift elimination)', () => {
  it('measures the drift a toggle leaves, then cancels it', () => {
    // Run the refine loop's rAFs synchronously.
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(0);
      return 0;
    });

    const h = makeScriptedAnchor({ docY: 800, scrollTop: 500 });
    expect(h.anchorViewportTop()).toBe(h.topBefore); // 300, before the change

    // The toggle collapses 120px of content above the anchor.
    h.setLayoutShift(-120);
    // BASELINE (no restore): the anchor has drifted up by 120px.
    expect(h.anchorViewportTop()).toBe(180);
    expect(h.anchorViewportTop() - h.topBefore).toBe(-120); // the measured drift

    // Restore: pins the anchor back to where it was.
    restoreViewportAnchor(h.anchor);
    expect(h.scroller.scrollTop).toBe(380); // 500 + (180 - 300)
    expect(h.anchorViewportTop()).toBe(h.topBefore); // zero drift
  });

  it('is a no-op when the anchor has no scroller', () => {
    const view = {
      dom: { isConnected: true },
      coordsAtPos: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
    } as unknown as EditorView;
    // Should not throw when scroller is null.
    expect(() =>
      restoreViewportAnchor({ view, scroller: null, pos: 1, topBefore: 0 }),
    ).not.toThrow();
  });
});

describe('nearestReadKeptPos (read-mode anchor target)', () => {
  const hl = schema.marks['highlight']!.create({ color: 'yellow' });

  function findRuns(doc: PMNode) {
    let hlFrom = -1;
    let hlTo = -1;
    let tagFrom = -1;
    let tagTo = -1;
    doc.descendants((node, pos) => {
      if (node.isText && node.text && node.marks.some((m) => m.type.name === 'highlight')) {
        hlFrom = pos;
        hlTo = pos + node.nodeSize;
      }
      if (node.type.name === 'tag') {
        tagFrom = pos + 1;
        tagTo = pos + node.nodeSize - 1;
      }
      return true;
    });
    return { hlFrom, hlTo, tagFrom, tagTo };
  }

  it('anchors to the highlighted run, not the card/tag boundary above it', () => {
    const doc = schema.node('doc', null, [
      schema.node('card', null, [
        schema.node('tag', { id: 't1' }, [schema.text('This is the tag line')]),
        schema.node('card_body', null, [
          schema.text('a good long stretch of non-highlighted filler text here '),
          schema.text('the highlighted sentence', [hl]),
          schema.text(' and then trailing filler'),
        ]),
      ]),
    ]);
    const { hlFrom, hlTo } = findRuns(doc);
    expect(hlFrom).toBeGreaterThan(0);
    // Reading a highlight → the anchor is that exact spot (the "works
    // fine" case the old block-snap threw away).
    const inside = hlFrom + 3;
    expect(nearestReadKeptPos(doc, inside)).toBe(inside);
    // In the filler just before the highlight → snaps to the highlight
    // run (kept in both modes), NOT back to the tag/card boundary.
    const res = nearestReadKeptPos(doc, hlFrom - 1);
    expect(res).not.toBeNull();
    expect(res!).toBeGreaterThanOrEqual(hlFrom);
    expect(res!).toBeLessThanOrEqual(hlTo);
  });

  it('falls back to heading text when the body has no read-aloud content', () => {
    const doc = schema.node('doc', null, [
      schema.node('card', null, [
        schema.node('tag', { id: 't2' }, [schema.text('Tag heading here')]),
        schema.node('card_body', null, [schema.text('entirely un-highlighted filler body text')]),
      ]),
    ]);
    const { tagFrom, tagTo } = findRuns(doc);
    const bodyPos = doc.content.size - 3; // deep in the filler
    const res = nearestReadKeptPos(doc, bodyPos);
    expect(res).not.toBeNull();
    expect(res!).toBeGreaterThanOrEqual(tagFrom);
    expect(res!).toBeLessThanOrEqual(tagTo);
  });
});

describe('firstReadKeptPos (read-mode anchor: first survivor scanning down)', () => {
  const hl = schema.marks['highlight']!.create({ color: 'yellow' });

  it('skips hidden body at the top and lands on the next surviving heading', () => {
    // Mirrors the field case: viewport top sits in an un-highlighted card
    // body (hidden in read mode); the next survivor is a block heading.
    const doc = schema.node('doc', null, [
      schema.node('card', null, [
        schema.node('tag', { id: 'a' }, [schema.text('the earlier card tag')]),
        schema.node('card_body', null, [
          schema.text('underlined but not highlighted filler body text here and here'),
        ]),
      ]),
      schema.node('block', { id: 'b' }, [schema.text('Impact---AT: Defense---AT: Empirics')]),
      schema.node('card', null, [
        schema.node('tag', { id: 'c' }, [schema.text('the next card tag')]),
        schema.node('card_body', null, [schema.text('lead '), schema.text('highlighted', [hl])]),
      ]),
    ]);
    let bodyPos = -1;
    let blockFrom = -1;
    let blockTo = -1;
    doc.descendants((node, pos) => {
      if (node.type.name === 'card_body' && bodyPos < 0) bodyPos = pos + 2;
      if (node.type.name === 'block') {
        blockFrom = pos + 1;
        blockTo = pos + node.nodeSize - 1;
      }
      return true;
    });
    const res = firstReadKeptPos(doc, bodyPos, doc.content.size);
    expect(res).not.toBeNull();
    // Lands on the block heading — NOT the tag above, NOT the highlight
    // two cards down.
    expect(res!).toBeGreaterThanOrEqual(blockFrom);
    expect(res!).toBeLessThanOrEqual(blockTo);
  });

  it('returns the reading position itself when the viewport top is already kept', () => {
    const doc = schema.node('doc', null, [
      schema.node('card', null, [
        schema.node('tag', { id: 'a' }, [schema.text('tag')]),
        schema.node('card_body', null, [
          schema.text('lead in '),
          schema.text('the highlighted reading spot', [hl]),
          schema.text(' trailing'),
        ]),
      ]),
    ]);
    let hlFrom = -1;
    let hlTo = -1;
    doc.descendants((node, pos) => {
      if (node.isText && node.marks.some((m) => m.type.name === 'highlight')) {
        hlFrom = pos;
        hlTo = pos + node.nodeSize;
      }
      return true;
    });
    const inside = hlFrom + 4;
    expect(firstReadKeptPos(doc, inside, doc.content.size)).toBe(inside);
    // From just before the highlight → snaps forward onto it.
    const res = firstReadKeptPos(doc, hlFrom - 2, doc.content.size);
    expect(res!).toBeGreaterThanOrEqual(hlFrom);
    expect(res!).toBeLessThanOrEqual(hlTo);
  });
});
