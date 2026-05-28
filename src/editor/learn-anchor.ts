/**
 * Learn — anchor descriptors (pure; no DOM, no I/O).
 *
 * Local annotations (flashcards, AI threads) aren't stored in the file, so
 * they can't leave a `comment_range` mark to anchor on. Instead each carries
 * an `AnchorDescriptor` — the quoted text plus a little surrounding context
 * and a position hint — and we re-resolve it against the live document when
 * the comments column opens (SPEC-learn-system §4.2). Hypothesis-style:
 * survives position shifts, and even a Word round-trip, as long as the text
 * itself is intact.
 *
 * We work over a flattened text view of the doc (text nodes concatenated in
 * document order) with a parallel map from char offset → ProseMirror
 * position, so a found quote maps back to a real `{from, to}` range.
 */

import type { Node as PMNode } from 'prosemirror-model';

/** ~30 chars of context on each side — enough to disambiguate repeats. */
const CONTEXT = 30;

export interface AnchorDescriptor {
  quote: string;
  prefix: string;
  suffix: string;
  approxPos: number; // char offset of the quote start at descriptor time
}

export interface ResolveResult {
  from: number;
  to: number;
  /** True when the quote occurred more than once and we had to pick
   *  (by context, then nearest position) — surfaced so the UI can flag it. */
  ambiguous: boolean;
}

interface Flat {
  text: string;
  /** `pos[i]` = the ProseMirror position immediately before flat char i. */
  pos: number[];
}

function flatten(doc: PMNode): Flat {
  let text = '';
  const pos: number[] = [];
  doc.descendants((node, p) => {
    if (node.isText) {
      const t = node.text ?? '';
      for (let i = 0; i < t.length; i++) {
        text += t[i];
        pos.push(p + i);
      }
    }
    return true;
  });
  return { text, pos };
}

/** PM position just after flat char `idx-1` (i.e. the right edge of the
 *  quote ending at idx). */
function endPos(flat: Flat, idx: number): number {
  if (idx < flat.pos.length) return flat.pos[idx]!; // left edge of next char
  // Quote runs to the last char: its right edge is one past the last left.
  return (flat.pos[flat.pos.length - 1] ?? 0) + 1;
}

/** Build a descriptor for the selection `[from, to)` in `doc`. */
export function buildDescriptor(doc: PMNode, from: number, to: number): AnchorDescriptor {
  const flat = flatten(doc);
  let start = flat.pos.findIndex((p) => p >= from);
  if (start < 0) start = flat.text.length;
  let end = flat.pos.findIndex((p) => p >= to);
  if (end < 0) end = flat.text.length;
  return {
    quote: flat.text.slice(start, end),
    prefix: flat.text.slice(Math.max(0, start - CONTEXT), start),
    suffix: flat.text.slice(end, end + CONTEXT),
    approxPos: start,
  };
}

/** Length of the common suffix of `a` and the trailing of `b` (how well a
 *  candidate's preceding text matches the stored prefix). */
function backMatch(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++;
  return n;
}

/** Length of the common prefix of `a` and `b`. */
function frontMatch(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return n;
}

/**
 * Re-resolve a descriptor against `doc`. Returns the matched range, or
 * `null` if the quote no longer occurs (the "broken grounding" case).
 * Multiple matches are disambiguated by surrounding-context match, then by
 * nearest position to `approxPos`; ties set `ambiguous`.
 */
export function resolveDescriptor(doc: PMNode, d: AnchorDescriptor): ResolveResult | null {
  if (d.quote === '') return null;
  const flat = flatten(doc);
  const hits: number[] = [];
  for (let i = flat.text.indexOf(d.quote); i >= 0; i = flat.text.indexOf(d.quote, i + 1)) {
    hits.push(i);
  }
  if (hits.length === 0) return null;

  let bestIdx = hits[0]!;
  let ambiguous = false;
  if (hits.length > 1) {
    const scored = hits.map((i) => {
      const before = flat.text.slice(Math.max(0, i - CONTEXT), i);
      const after = flat.text.slice(i + d.quote.length, i + d.quote.length + CONTEXT);
      const context = backMatch(before, d.prefix) + frontMatch(after, d.suffix);
      return { i, context, dist: Math.abs(i - d.approxPos) };
    });
    scored.sort((a, b) => b.context - a.context || a.dist - b.dist);
    bestIdx = scored[0]!.i;
    // Ambiguous if the runner-up matched context just as well and sat equally
    // close — i.e. context didn't actually distinguish them.
    const top = scored[0]!;
    ambiguous = scored.some((s) => s.i !== top.i && s.context === top.context && s.dist === top.dist);
  }

  return {
    from: flat.pos[bestIdx]!,
    to: endPos(flat, bestIdx + d.quote.length),
    ambiguous,
  };
}
