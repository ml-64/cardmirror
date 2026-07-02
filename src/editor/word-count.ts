/**
 * Read-aloud word counting.
 *
 * The "read-aloud" predicate:
 *   - All text inside a `tag` paragraph
 *   - All text inside an `analytic` paragraph
 *   - Text carrying the `cite_mark` mark (typically inside `cite_paragraph`)
 *   - Text in body-level paragraphs (`card_body` / `paragraph` / `undertag`)
 *     iff carrying the `highlight` mark AND NOT the `shading` mark
 *
 * Shading (the D2D2D2 protected-highlight via `HighlightToBackgroundColor`)
 * is excluded — that text is reference-style and not read aloud.
 */

import type { Node as PMNode } from 'prosemirror-model';

/** Reader profile: name + words-per-minute. */
export interface Reader {
  name: string;
  wpm: number;
}

/**
 * Count read-aloud words in [from, to). When `from`/`to` are omitted,
 * counts the entire doc.
 */
export function countReadAloudWords(doc: PMNode, from?: number, to?: number): number {
  const lo = from ?? 0;
  const hi = to ?? doc.content.size;
  if (lo >= hi) return 0;
  let count = 0;
  doc.nodesBetween(lo, hi, (node, pos, parent) => {
    if (!node.isText) return true;
    if (!parent) return false;
    if (!isReadAloudText(node, parent)) return false;
    const text = node.text ?? '';
    // Slice the text to the [lo, hi] window.
    const start = Math.max(0, lo - pos);
    const end = Math.min(text.length, hi - pos);
    if (end <= start) return false;
    count += countWords(text.slice(start, end));
    return false;
  });
  return count;
}

function isReadAloudText(node: PMNode, parent: PMNode): boolean {
  const parentType = parent.type.name;
  if (parentType === 'tag' || parentType === 'analytic') return true;
  if (node.marks.some((m) => m.type.name === 'cite_mark')) return true;
  if (parentType === 'card_body' || parentType === 'paragraph' || parentType === 'undertag') {
    const hasHighlight = node.marks.some((m) => m.type.name === 'highlight');
    const hasShading = node.marks.some((m) => m.type.name === 'shading');
    return hasHighlight && !hasShading;
  }
  return false;
}

function countWords(s: string): number {
  const trimmed = s.trim();
  if (trimmed.length === 0) return 0;
  return trimmed.split(/\s+/).length;
}

/** Format reading time as "M:SS" given a word count and reader's WPM. */
export function formatReadTime(words: number, wpm: number): string {
  if (wpm <= 0) return '—';
  const seconds = (words / wpm) * 60;
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** Format a number with thousands separators ("1,024"). */
export function formatNumber(n: number): string {
  return n.toLocaleString('en-US');
}
