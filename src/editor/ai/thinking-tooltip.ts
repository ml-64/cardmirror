/**
 * Floating "Thinking…" pill shown while an AI request is in flight.
 * Shared by every AI feature that doesn't have its own side-panel
 * placeholder — cite-creator, repair, the card cutter, generate-alt-
 * text, generate-table-from-image, etc.
 *
 * Positioning: the pill hugs the LEFT edge of the editor, vertically
 * just above the target selection. Because a long card can scroll the
 * selection out of view (and the selection itself is cleared while the
 * AI works), the pill clamps into the editor's visible area: if the
 * target is scrolled off the top it pins to the editor's top-left
 * corner; if it's off the bottom it pins to the bottom-left, just
 * above the dropzone. It re-positions on scroll/resize so it stays put
 * relative to the editor as the doc moves underneath it.
 *
 * When Clod mode is on, the pill cycles through the user's persona
 * activities; otherwise it just reads "Thinking…".
 */

import type { EditorView } from 'prosemirror-view';
import { settings } from '../settings.js';
import { rangeRect } from './ai-working-box.js';
import {
  activitiesForNow,
  pickRandomActivity,
  personalizeActivity,
} from './clod.js';
import { getAiPersona } from '../comments-ui.js';
import { makeActivityStage, cycleActivityText } from './activity-cycler.js';

/** Cycle interval. Matches the cite-creator's prior local constant. */
const ACTIVITY_TICK_MS = 4000;

/** Gap (px) between the pill and the editor edges / the selection. */
const EDGE = 8;
const SEL_GAP = 6;

export interface TooltipRange {
  from: number;
  to: number;
}

/** Find the on-screen editor box (single-doc `#editor` or a multi-doc
 *  pane) so the pill can anchor to the editor, not the whole page. */
function editorBox(view: EditorView): HTMLElement {
  return (
    (view.dom.closest('#editor, .pmd-pane-editor') as HTMLElement | null) ??
    (view.dom.parentElement as HTMLElement) ??
    view.dom
  );
}

/** Bottom edge (viewport y) of the fixed top chrome — the ribbon plus
 *  the speech banner when shown — so the pill never tucks behind it. */
function topChromeBottom(): number {
  let bottom = 0;
  const ribbon = document.getElementById('ribbon');
  if (ribbon) bottom = Math.max(bottom, ribbon.getBoundingClientRect().bottom);
  if (document.body.classList.contains('pmd-speech-banner-visible')) {
    const banner = document.getElementById('speech-doc-banner');
    if (banner) bottom = Math.max(bottom, banner.getBoundingClientRect().bottom);
  }
  return bottom;
}

/** A single visible pill anchored to the editor + a doc range. `show()`
 *  mounts and starts tracking; `setRange()` re-anchors (e.g. between
 *  repair passes); `hide()` cleans up. */
export class ThinkingTooltip {
  private el: HTMLDivElement | null = null;
  private ticker: number | null = null;
  private view: EditorView | null = null;
  private range: TooltipRange = { from: 0, to: 0 };
  /** When set, the pill names the current stage instead of cycling
   *  generic activities (used by the card cutter). A gerund phrase like
   *  "pruning for redundancy". */
  private stageText: string | null = null;
  private readonly onScroll = (): void => this.reposition();

  /** Name the current pipeline stage (or null to return to the generic
   *  "Thinking…" / Clod activity). Updates the pill immediately. */
  setStage(stage: string | null): void {
    this.stageText = stage;
    if (!this.el) return;
    const s = this.el.querySelector<HTMLElement>('.pmd-activity-stage');
    if (s) cycleActivityText(s, this.currentText());
    this.reposition();
  }

  show(view: EditorView, range: TooltipRange): void {
    if (this.el) {
      this.setRange(range);
      return;
    }
    this.view = view;
    this.range = range;
    const el = document.createElement('div');
    el.className = 'pmd-ai-cite-tooltip';
    el.style.position = 'fixed';
    el.appendChild(makeActivityStage(this.currentText()));
    document.body.appendChild(el);
    this.el = el;
    this.reposition();

    // Capture-phase scroll catches the editor's inner scroller too
    // (scroll events don't bubble); resize handles window changes.
    window.addEventListener('scroll', this.onScroll, true);
    window.addEventListener('resize', this.onScroll);

    this.ticker = window.setInterval(() => {
      if (!this.el) return;
      const stage = this.el.querySelector<HTMLElement>('.pmd-activity-stage');
      if (stage) cycleActivityText(stage, this.currentText());
      this.reposition(); // width/height can change as text cycles
    }, ACTIVITY_TICK_MS);
  }

  /** Re-anchor to a new range (positions may have been re-mapped). */
  setRange(range: TooltipRange): void {
    this.range = range;
    this.reposition();
  }

  hide(): void {
    if (this.ticker !== null) {
      window.clearInterval(this.ticker);
      this.ticker = null;
    }
    window.removeEventListener('scroll', this.onScroll, true);
    window.removeEventListener('resize', this.onScroll);
    if (this.el) {
      this.el.remove();
      this.el = null;
    }
    this.view = null;
  }

  /** Place the pill at the editor's left edge, vertically tracking the
   *  selection but clamped into the editor's visible band. */
  private reposition(): void {
    if (!this.el || !this.view) return;
    const box = editorBox(this.view).getBoundingClientRect();
    // Visible editor band = editor box ∩ viewport, kept clear of the
    // fixed ribbon/banner at the top.
    const bandTop = Math.max(box.top, topChromeBottom(), 0) + EDGE;
    const bandBottom = Math.min(box.bottom, window.innerHeight) - EDGE;
    const pillH = this.el.offsetHeight || 28;

    // Where the target sits in the viewport (may be off-screen). Use the
    // range's DOM bounding rect so an image (an inline atom) anchors to
    // its real box — `coordsAtPos` returns only a degenerate caret rect
    // for an atom, which pinned the pill to the top-left corner.
    let selTop: number;
    let selBottom: number;
    const rect = rangeRect(this.view, this.range);
    if (rect) {
      selTop = rect.top;
      selBottom = rect.bottom;
    } else {
      // Collapsed range (no width): a point anchor.
      try {
        const a = this.view.coordsAtPos(this.range.from);
        selTop = a.top;
        selBottom = a.bottom;
      } catch {
        selTop = bandTop;
        selBottom = bandTop;
      }
    }

    // The pill's own bottom must clear the dropzone when it sits low.
    const dz = document.querySelector('.pmd-dropzone-root');
    const dropFloor = dz
      ? Math.min(dz.getBoundingClientRect().top - SEL_GAP, bandBottom)
      : bandBottom;

    let top: number;
    if (selBottom < bandTop) {
      top = bandTop; // target scrolled off the top → editor top-left
    } else if (selTop > bandBottom) {
      top = dropFloor - pillH; // target scrolled off the bottom → bottom-left
    } else {
      top = selTop - pillH - SEL_GAP; // just above the target
    }
    top = Math.max(bandTop, Math.min(top, dropFloor - pillH));

    this.el.style.left = `${box.left + EDGE}px`;
    this.el.style.top = `${top}px`;
  }

  private currentText(): string {
    // Card-cutter stage narration overrides the generic activity.
    if (this.stageText) {
      const s = this.stageText;
      return settings.get('clodEnabled')
        ? `Clod is ${s}…`
        : `${s.charAt(0).toUpperCase()}${s.slice(1)}…`;
    }
    if (!settings.get('clodEnabled')) return 'Thinking…';
    const pool = activitiesForNow({
      customByTime: settings.get('clodActivitiesByTime'),
      ranges: settings.get('clodTimePeriods'),
    });
    return personalizeActivity(pickRandomActivity(pool), getAiPersona());
  }
}
