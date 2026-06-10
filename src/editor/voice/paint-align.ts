/**
 * Karaoke paint alignment (SPEC-voice.md §6): match a stream of spoken
 * words against document tokens, monotonically forward from an anchor.
 * Returns the spans of document text actually READ (skipped text is
 * never marked) and the reading-head position.
 *
 * Properties the spec requires:
 *  - small skips (≤ ~15 words) are found by the forward search;
 *  - disfluencies ("uh", repeated words) are absorbed — an unmatched
 *    spoken word just doesn't advance the head;
 *  - re-reading already-confirmed words re-aligns harmlessly (monotone
 *    forward matching skips backward restarts instead of jumping back).
 */
import type { TokenSpan } from './align.js';
import { normalizeWord, mergeSpokenNumbers } from './align.js';

export interface PaintSpan {
  from: number;
  to: number;
}

/** How far ahead (in tokens) the aligner searches for the next spoken
 *  word — the spec's "small skips are found automatically". */
const SKIP_LOOKAHEAD = 18;
const MAX_WORD_DISTANCE = 0.34;

function wordDistance(a: string, b: string): number {
  if (a === b) return 0;
  const la = a.length;
  const lb = b.length;
  if (la === 0 || lb === 0) return 1;
  if (Math.abs(la - lb) > 3) return 1;
  let prev = new Array<number>(lb + 1);
  let curr = new Array<number>(lb + 1);
  for (let j = 0; j <= lb; j++) prev[j] = j;
  for (let i = 1; i <= la; i++) {
    curr[0] = i;
    for (let j = 1; j <= lb; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        (prev[j] as number) + 1,
        (curr[j - 1] as number) + 1,
        (prev[j - 1] as number) + cost,
      );
    }
    [prev, curr] = [curr, prev];
  }
  return (prev[lb] as number) / Math.max(la, lb);
}

export interface AlignReadingResult {
  /** Merged spans of matched (read) document text, document order. */
  spans: PaintSpan[];
  /** Document position just after the last matched token — where the
   *  reading head sits. Equals the anchor when nothing matched. */
  headPos: number;
  /** Count of spoken words that matched (confidence signal). */
  matched: number;
}

export function alignReading(
  tokens: TokenSpan[],
  spokenText: string,
  anchorPos: number,
): AlignReadingResult {
  const spoken = mergeSpokenNumbers(
    spokenText.split(/\s+/).map(normalizeWord).filter(Boolean),
  );
  let ti = tokens.findIndex((t) => t.from >= anchorPos);
  if (ti < 0) ti = tokens.length;

  const matchedIdx: number[] = [];
  for (let wi = 0; wi < spoken.length; wi++) {
    const word = spoken[wi] as string;
    // Best fuzzy match within the lookahead window; earlier wins ties
    // so unread text between head and a far duplicate stays unmarked.
    let bestJ = -1;
    let bestD = MAX_WORD_DISTANCE + 1e-9;
    const end = Math.min(tokens.length, ti + SKIP_LOOKAHEAD);
    for (let j = ti; j < end; j++) {
      const d = wordDistance(word, (tokens[j] as TokenSpan).norm);
      if (d < bestD - 1e-9) {
        bestD = d;
        bestJ = j;
        if (d === 0) break;
      }
    }
    // Restart guard: a jump past more than 3 unread tokens is accepted
    // only when the NEXT spoken word continues contiguously at the
    // landing point. Re-spoken function words from a stumble-restart
    // ("…argue that — critics argue that arms…") otherwise match a far
    // duplicate and drag the head past unread text.
    if (bestJ > ti + 3) {
      const next = spoken[wi + 1];
      const confirm =
        next !== undefined &&
        bestJ + 1 < tokens.length &&
        wordDistance(next, (tokens[bestJ + 1] as TokenSpan).norm) <= MAX_WORD_DISTANCE;
      if (!confirm) continue; // absorbed
    }
    if (bestJ >= 0) {
      matchedIdx.push(bestJ);
      ti = bestJ + 1;
    }
    // No match → disfluency / restart / out-of-text word: absorbed.
  }

  const spans: PaintSpan[] = [];
  for (const idx of matchedIdx) {
    const tok = tokens[idx] as TokenSpan;
    const last = spans[spans.length - 1];
    // Merge runs separated only by whitespace/punctuation (≤ 3 chars).
    if (last && tok.from - last.to <= 3) last.to = tok.to;
    else spans.push({ from: tok.from, to: tok.to });
  }
  const lastIdx = matchedIdx[matchedIdx.length - 1];
  return {
    spans,
    headPos: lastIdx !== undefined ? (tokens[lastIdx] as TokenSpan).to : anchorPos,
    matched: matchedIdx.length,
  };
}
