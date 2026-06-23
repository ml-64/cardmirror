/**
 * In-app performance benchmark — a game-style suite that runs a battery of real
 * in-editor operations on the currently open document and reports frame rate,
 * frame-time percentiles, and operation latencies. Surfaced in Settings →
 * Benchmark (see `benchmark-ui.ts`).
 *
 * Self-instrumented via `requestAnimationFrame` + `PerformanceObserver`, so it
 * measures CardMirror's OWN rendering. It is deliberately NOT the cross-app
 * comparison — that's the black-box screen-capture rig in `perf/`, which is the
 * only fair way to put Word and CardMirror on the same axis.
 *
 * The editor must be VISIBLE while this runs (occluded content gets its paints
 * culled by the compositor, which would falsify the frame times), so the UI
 * closes any modal and shows only a small corner chip during the run.
 */

import { EditorState } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import { preciseScrollIntoView } from './precise-scroll.js';

const HEADING_NODES = new Set(['pocket', 'hat', 'block', 'tag']);

export interface FrameStats {
  frames: number;
  fps: number; // mean
  p50FrameMs: number;
  p95FrameMs: number;
  p99FrameMs: number;
  lowFps1pct: number; // 1%-low fps, derived from the p99 frame time
  jankFrames: number; // frames longer than 1.5x the median
}

export interface BenchmarkResults {
  docInfo: { headings: number; cards: number; chars: number };
  scroll: (FrameStats & { durationMs: number; frameMs: number[] }) | null;
  nav: { medianMs: number; p90Ms: number; samples: number[] } | null;
  relayout: { ms: number } | null;
  longTasks: { count: number; totalMs: number; maxMs: number };
  score: number;
}

export type ProgressFn = (label: string) => void;

const raf = (): Promise<number> => new Promise((r) => requestAnimationFrame(r));
async function nextPaint(): Promise<void> {
  await raf();
  await raf();
}
const round1 = (x: number): number => Math.round(x * 10) / 10;

function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))));
  return sorted[i]!;
}

function frameStats(intervals: number[]): FrameStats {
  const valid = intervals.filter((x) => x > 0 && x < 1000);
  const sorted = [...valid].sort((a, b) => a - b);
  const mean = valid.length ? valid.reduce((a, b) => a + b, 0) / valid.length : 0;
  const median = pct(sorted, 50);
  const p99 = pct(sorted, 99);
  return {
    frames: valid.length,
    fps: mean ? Math.round(1000 / mean) : 0,
    p50FrameMs: round1(median),
    p95FrameMs: round1(pct(sorted, 95)),
    p99FrameMs: round1(p99),
    lowFps1pct: p99 ? Math.round(1000 / p99) : 0,
    jankFrames: median ? valid.filter((x) => x > 1.5 * median).length : 0,
  };
}

/** The element that actually scrolls behind the editor (walk up to the first
 *  overflow:auto/scroll ancestor; mirrors `precise-scroll`'s own gate logic). */
function scrollGate(view: EditorView): HTMLElement {
  let cur: HTMLElement | null = view.dom as HTMLElement;
  while (cur && cur !== document.body) {
    const oy = getComputedStyle(cur).overflowY;
    if ((oy === 'auto' || oy === 'scroll') && cur.scrollHeight > cur.clientHeight) return cur;
    cur = cur.parentElement;
  }
  return (document.scrollingElement as HTMLElement | null) ?? document.documentElement;
}

function headingPositions(view: EditorView): number[] {
  const out: number[] = [];
  view.state.doc.descendants((node, pos) => {
    if (HEADING_NODES.has(node.type.name)) out.push(pos);
    return true;
  });
  return out;
}

/** Continuously scroll top→bottom over `durationMs`, sampling each frame's
 *  interval. The scroll position is driven by elapsed time (not frame count),
 *  so a slow renderer scrolls the same distance but yields longer frames. */
async function benchScroll(
  view: EditorView,
  durationMs: number,
): Promise<FrameStats & { durationMs: number; frameMs: number[] }> {
  const gate = scrollGate(view);
  const startTop = gate.scrollTop;
  gate.scrollTop = 0;
  await nextPaint();
  const max = Math.max(1, gate.scrollHeight - gate.clientHeight);
  const intervals: number[] = [];
  const t0 = performance.now();
  let last = t0;
  for (;;) {
    const now = await raf();
    intervals.push(now - last);
    last = now;
    const frac = (now - t0) / durationMs;
    gate.scrollTop = Math.min(max, frac * max);
    if (now - t0 >= durationMs || gate.scrollTop >= max) break;
  }
  const durationActual = performance.now() - t0;
  gate.scrollTop = startTop;
  await nextPaint();
  // Drop the first interval (warm-up / measurement start jitter).
  const frameMs = intervals.slice(1).map((x) => round1(x));
  return { ...frameStats(intervals.slice(1)), durationMs: Math.round(durationActual), frameMs };
}

async function settleScroll(gate: HTMLElement): Promise<void> {
  let stable = 0;
  let lastTop = gate.scrollTop;
  for (let i = 0; i < 300; i++) {
    await raf();
    if (Math.abs(gate.scrollTop - lastTop) < 0.5) {
      if (++stable >= 5) return;
    } else {
      stable = 0;
    }
    lastTop = gate.scrollTop;
  }
}

/** Jump to several headings spread across the doc (the same `preciseScrollIntoView`
 *  the nav pane uses), timing click→settled for each. */
async function benchNav(
  view: EditorView,
): Promise<{ medianMs: number; p90Ms: number; samples: number[] } | null> {
  const positions = headingPositions(view);
  if (positions.length < 4) return null;
  const gate = scrollGate(view);
  const fracs = [0.12, 0.3, 0.5, 0.68, 0.85, 0.95];
  const samples: number[] = [];
  for (const f of fracs) {
    const pos = positions[Math.floor(f * (positions.length - 1))]!;
    gate.scrollTop = 0;
    await nextPaint();
    const dom = view.nodeDOM(pos);
    if (!(dom instanceof HTMLElement)) continue;
    const t0 = performance.now();
    preciseScrollIntoView(view, dom, 'center');
    await settleScroll(gate);
    samples.push(performance.now() - t0);
  }
  if (samples.length === 0) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    medianMs: round1(pct(sorted, 50)),
    p90Ms: round1(pct(sorted, 90)),
    samples: samples.map(round1),
  };
}

/** Force a full relayout + repaint of the whole editor subtree (a proxy for the
 *  layout half of "open this document"). Non-destructive — no state is rebuilt. */
async function benchRelayout(view: EditorView): Promise<{ ms: number }> {
  const el = view.dom as HTMLElement;
  const prev = el.style.display;
  await nextPaint();
  const t0 = performance.now();
  el.style.display = 'none';
  void el.offsetHeight; // flush the teardown
  el.style.display = prev;
  void el.offsetHeight; // force the full relayout synchronously
  await nextPaint(); // include the paint
  const ms = performance.now() - t0;
  return { ms: round1(ms) };
}

function computeScore(r: BenchmarkResults): number {
  let s = 0;
  if (r.scroll) s += r.scroll.fps * 3 + r.scroll.lowFps1pct * 2 - r.scroll.jankFrames * 2;
  if (r.nav) s += Math.max(0, 2000 - r.nav.medianMs) / 4;
  if (r.relayout) s += Math.max(0, 1000 - r.relayout.ms) / 4;
  s -= r.longTasks.totalMs / 10;
  return Math.max(0, Math.round(s));
}

/** Run the full battery on the active view's current document. Reports progress
 *  by label. The editor must be visible (caller closes any modal first). */
export async function runBenchmark(view: EditorView, onProgress?: ProgressFn): Promise<BenchmarkResults> {
  let headings = 0;
  let cards = 0;
  let chars = 0;
  view.state.doc.descendants((node) => {
    if (HEADING_NODES.has(node.type.name)) headings++;
    if (node.type.name === 'card') cards++;
    if (node.isText) chars += node.text?.length ?? 0;
    return true;
  });

  const longTaskDurations: number[] = [];
  let obs: PerformanceObserver | null = null;
  try {
    obs = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) longTaskDurations.push(e.duration);
    });
    obs.observe({ type: 'longtask', buffered: false });
  } catch {
    /* longtask timing unsupported (e.g. Safari) — skip */
  }

  onProgress?.('Warming up…');
  await nextPaint();
  onProgress?.('Scrolling…');
  const scroll = await benchScroll(view, 4000);
  onProgress?.('Navigating…');
  const nav = await benchNav(view);
  onProgress?.('Relayout…');
  const relayout = await benchRelayout(view);
  obs?.disconnect();

  const total = Math.round(longTaskDurations.reduce((a, b) => a + b, 0));
  const results: BenchmarkResults = {
    docInfo: { headings, cards, chars },
    scroll,
    nav,
    relayout,
    longTasks: {
      count: longTaskDurations.length,
      totalMs: total,
      maxMs: Math.round(longTaskDurations.length ? Math.max(...longTaskDurations) : 0),
    },
    score: 0,
  };
  results.score = computeScore(results);
  return results;
}
