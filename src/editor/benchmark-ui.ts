/**
 * UI for the in-app benchmark (Settings → Benchmark). Launches the battery in
 * `benchmark.ts` with only a small corner chip on screen (so the editor stays
 * visible and its paints aren't culled), then shows a game-style results card
 * with a frame-time graph.
 */

import { getActiveView } from './index.js';
import { runBenchmark, type BenchmarkResults } from './benchmark.js';

let running = false;

export async function launchBenchmarkOverlay(): Promise<void> {
  if (running) return;
  const view = getActiveView();
  if (!view) {
    showMessage('Open a document first, then run the benchmark.');
    return;
  }
  running = true;
  const chip = makeChip();
  document.body.appendChild(chip.el);
  // One frame so the chip paints and the (now modal-free) editor is on screen.
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  let results: BenchmarkResults | null = null;
  try {
    results = await runBenchmark(view, (label) => chip.set(label));
  } catch (err) {
    console.error('[benchmark] failed', err);
  } finally {
    chip.el.remove();
    running = false;
  }
  if (results) showResults(results);
  else showMessage('Benchmark failed — see the console.');
}

function makeChip(): { el: HTMLElement; set: (s: string) => void } {
  const el = document.createElement('div');
  el.className = 'pmd-bench-chip';
  const dot = document.createElement('span');
  dot.className = 'pmd-bench-chip-dot';
  const txt = document.createElement('span');
  txt.textContent = 'Benchmarking…';
  el.append(dot, txt);
  return { el, set: (s) => (txt.textContent = `Benchmarking — ${s}`) };
}

function overlay(): { root: HTMLElement; dialog: HTMLElement; close: () => void } {
  const root = document.createElement('div');
  root.className = 'pmd-bench-overlay';
  const dialog = document.createElement('div');
  dialog.className = 'pmd-bench-dialog';
  root.appendChild(dialog);
  const close = (): void => root.remove();
  root.addEventListener('mousedown', (e) => {
    if (e.target === root) close();
  });
  document.addEventListener(
    'keydown',
    (e) => {
      if (e.key === 'Escape' && document.body.contains(root)) close();
    },
    { once: true },
  );
  document.body.appendChild(root);
  return { root, dialog, close };
}

function showMessage(msg: string): void {
  const { dialog, close } = overlay();
  const p = document.createElement('p');
  p.className = 'pmd-bench-msg';
  p.textContent = msg;
  const btn = button('Close', close);
  dialog.append(p, footer([btn]));
}

function showResults(r: BenchmarkResults): void {
  const { dialog, close } = overlay();

  const header = document.createElement('div');
  header.className = 'pmd-bench-header';
  const h = document.createElement('h2');
  h.textContent = 'Benchmark results';
  header.appendChild(h);
  dialog.appendChild(header);

  const scoreWrap = document.createElement('div');
  scoreWrap.className = 'pmd-bench-score';
  const scoreNum = document.createElement('div');
  scoreNum.className = 'pmd-bench-score-num';
  scoreNum.textContent = String(r.score);
  const scoreLbl = document.createElement('div');
  scoreLbl.className = 'pmd-bench-score-lbl';
  scoreLbl.textContent = 'SCORE';
  scoreWrap.append(scoreNum, scoreLbl);
  dialog.appendChild(scoreWrap);

  const grid = document.createElement('div');
  grid.className = 'pmd-bench-grid';
  if (r.scroll) {
    grid.appendChild(
      card('Scroll', [
        ['Avg FPS', String(r.scroll.fps)],
        ['1% low FPS', String(r.scroll.lowFps1pct)],
        ['p99 frame', `${r.scroll.p99FrameMs} ms`],
        ['Jank frames', String(r.scroll.jankFrames)],
      ]),
    );
  }
  grid.appendChild(
    card(
      'Navigation',
      r.nav
        ? [
            ['Median', `${r.nav.medianMs} ms`],
            ['p90', `${r.nav.p90Ms} ms`],
            ['Jumps', String(r.nav.samples.length)],
          ]
        : [['—', 'needs ≥4 headings']],
    ),
  );
  grid.appendChild(
    card('Relayout', r.relayout ? [['Full document', `${r.relayout.ms} ms`]] : [['—', 'n/a']]),
  );
  grid.appendChild(
    card('Long tasks', [
      ['Count', String(r.longTasks.count)],
      ['Total', `${r.longTasks.totalMs} ms`],
      ['Longest', `${r.longTasks.maxMs} ms`],
    ]),
  );
  grid.appendChild(
    card('Document', [
      ['Headings', String(r.docInfo.headings)],
      ['Cards', String(r.docInfo.cards)],
      ['Characters', r.docInfo.chars.toLocaleString()],
    ]),
  );
  dialog.appendChild(grid);

  if (r.scroll && r.scroll.frameMs.length > 2) {
    dialog.appendChild(frameGraph(r.scroll.frameMs));
  }

  const note = document.createElement('p');
  note.className = 'pmd-bench-note';
  note.textContent =
    "Self-reported (CardMirror's own renderer). FPS is capped by your display's " +
    'refresh rate. For the apples-to-apples comparison against Word, see the perf/ rig.';
  dialog.appendChild(note);

  dialog.appendChild(
    footer([
      button('Run again', () => {
        close();
        void launchBenchmarkOverlay();
      }),
      button('Close', close, true),
    ]),
  );
}

function card(title: string, rows: [string, string][]): HTMLElement {
  const c = document.createElement('div');
  c.className = 'pmd-bench-card';
  const t = document.createElement('div');
  t.className = 'pmd-bench-card-title';
  t.textContent = title;
  c.appendChild(t);
  for (const [label, value] of rows) {
    const row = document.createElement('div');
    row.className = 'pmd-bench-card-row';
    const l = document.createElement('span');
    l.textContent = label;
    const v = document.createElement('span');
    v.className = 'pmd-bench-card-val';
    v.textContent = value;
    row.append(l, v);
    c.appendChild(row);
  }
  return c;
}

function frameGraph(frameMs: number[]): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'pmd-bench-graph';
  const cap = document.createElement('div');
  cap.className = 'pmd-bench-graph-cap';
  cap.textContent = 'Scroll frame times (lower is smoother; line = 60 fps / 16.7 ms)';
  const canvas = document.createElement('canvas');
  const W = 760;
  const H = 140;
  canvas.width = W;
  canvas.height = H;
  wrap.append(cap, canvas);
  const ctx = canvas.getContext('2d');
  if (!ctx) return wrap;

  // Downsample to canvas width, plotting the worst (max) frame per bucket so
  // spikes survive — that's what the eye perceives as jank.
  const n = Math.min(W, frameMs.length);
  const bucket = frameMs.length / n;
  const series: number[] = [];
  for (let i = 0; i < n; i++) {
    let m = 0;
    for (let j = Math.floor(i * bucket); j < Math.floor((i + 1) * bucket); j++) m = Math.max(m, frameMs[j] ?? 0);
    series.push(m);
  }
  const maxMs = Math.max(33, ...series);
  const y = (ms: number): number => H - (ms / maxMs) * (H - 8) - 4;

  ctx.fillStyle = '#1b1d22';
  ctx.fillRect(0, 0, W, H);
  // 60 fps reference line
  ctx.strokeStyle = '#3a7d44';
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(0, y(16.7));
  ctx.lineTo(W, y(16.7));
  ctx.stroke();
  ctx.setLineDash([]);
  // frame-time line
  ctx.strokeStyle = '#7fd1ff';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  series.forEach((ms, i) => {
    const px = (i / Math.max(1, n - 1)) * W;
    if (i === 0) ctx.moveTo(px, y(ms));
    else ctx.lineTo(px, y(ms));
  });
  ctx.stroke();
  return wrap;
}

function button(label: string, onClick: () => void, primary = false): HTMLButtonElement {
  const b = document.createElement('button');
  b.className = primary ? 'pmd-bench-btn pmd-bench-btn-primary' : 'pmd-bench-btn';
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

function footer(buttons: HTMLElement[]): HTMLElement {
  const f = document.createElement('div');
  f.className = 'pmd-bench-footer';
  f.append(...buttons);
  return f;
}
