/**
 * Speak-to-target quote alignment (SPEC-voice.md §4.1): match 1–6
 * spoken words against document text. Normalization is case-folded,
 * punctuation-stripped, with numerals matched both ways; scoring is
 * word-level fuzzy edit distance weighted by proximity to the cursor,
 * searching forward first.
 *
 * `findQuote` is the self-contained resolver (margin-based ambiguity);
 * `quoteCandidates` exposes the ranked span list so dispatch can apply
 * the visibility-aware picker rule (identical matches onscreen → pick).
 */
import type { Node as PMNode } from 'prosemirror-model';

export interface TokenSpan {
  norm: string;
  from: number;
  to: number;
}

const NUMBER_WORDS: Record<string, string> = {
  zero: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6',
  seven: '7', eight: '8', nine: '9', ten: '10', eleven: '11', twelve: '12',
  thirteen: '13', fourteen: '14', fifteen: '15', sixteen: '16', seventeen: '17',
  eighteen: '18', nineteen: '19', twenty: '20', thirty: '30', forty: '40',
  fifty: '50', sixty: '60', seventy: '70', eighty: '80', ninety: '90',
  hundred: '100', thousand: '1000',
};

export function normalizeWord(word: string): string {
  const lower = word.toLowerCase().replace(/[^a-z0-9]/g, '');
  return NUMBER_WORDS[lower] ?? lower;
}

/** Merge spoken compound numbers ("twenty four" → "24") so they can
 *  match single digit tokens in the document. */
export function mergeSpokenNumbers(words: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i] as string;
    const next = words[i + 1];
    if (/^[2-9]0$/.test(w) && next && /^[1-9]$/.test(next)) {
      out.push(String(parseInt(w, 10) + parseInt(next, 10)));
      i++;
    } else {
      out.push(w);
    }
  }
  return out;
}

/** Full-document token caches, keyed on doc identity — ProseMirror
 *  docs are immutable, so reference equality is a sound cache key.
 *  Measured: a 100k-word doc costs ~39ms to tokenize and every voice
 *  movement command needs the full token list; a cached repeat is
 *  ~0.001ms with an identical array. Windowed calls (paint,
 *  near-pass) are cheap and stay uncached. */
const fullDocTokenCache = new WeakMap<PMNode, Map<string, TokenSpan[]>>();

/**
 * Tokenize document text into normalized words with positions.
 * Hyphenated compounds are tokenized per `hyphens`: 'joined' emits one
 * token ("antiwar"), 'split' emits the parts ("anti", "war") — the
 * search runs over both tracks so either spoken form matches, without
 * alternative tokens breaking window adjacency.
 */
export function collectTokens(
  doc: PMNode,
  hyphens: 'joined' | 'split',
  from = 0,
  to = doc.content.size,
): TokenSpan[] {
  const isFullDoc = from === 0 && to === doc.content.size;
  if (isFullDoc) {
    const cached = fullDocTokenCache.get(doc)?.get(hyphens);
    if (cached) return cached;
  }
  const tokens: TokenSpan[] = [];
  doc.nodesBetween(from, to, (node, pos) => {
    if (!node.isText || !node.text) return true;
    const re = /[A-Za-z0-9'’-]+/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(node.text)) !== null) {
      const wFrom = pos + m.index;
      const wTo = wFrom + m[0].length;
      const parts = m[0].split(/[-‐‑]/).filter(Boolean);
      if (hyphens === 'split' && parts.length > 1) {
        for (const part of parts) {
          const norm = normalizeWord(part);
          if (norm) tokens.push({ norm, from: wFrom, to: wTo });
        }
      } else {
        const norm = normalizeWord(m[0].replace(/[-‐‑]/g, ''));
        if (norm) tokens.push({ norm, from: wFrom, to: wTo });
      }
    }
    return true;
  });
  if (isFullDoc) {
    let per = fullDocTokenCache.get(doc);
    if (!per) fullDocTokenCache.set(doc, (per = new Map()));
    per.set(hyphens, tokens);
  }
  return tokens;
}

/** Bounded Levenshtein, normalized to 0..1 by the longer length. */
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

/** Radius (chars) of the near-cursor region used both as the decode
 *  vocabulary source (controller) and the first matching pass (dispatch). */
export const VOICE_NEAR_RADIUS = 2500;

export type AlignResult =
  | { status: 'match'; from: number; to: number }
  | { status: 'ambiguous'; candidates: Array<{ from: number; to: number }> }
  | { status: 'none' };

export const MAX_AVG_DISTANCE = 0.34; // roughly: most words right, small slips absorbed
/** Proximity: score penalty per token of distance from cursor. */
const PROXIMITY_PENALTY = 1 / 2000;
/** Flat extra cost for matches behind the cursor — forward-first (§4.1:
 *  "cutting proceeds forward"). Large enough that a forward match beats
 *  a same-text backward one decisively. */
const BACKWARD_OFFSET = 0.05;
/** Two candidates closer than this in final score → reactive
 *  disambiguation. Proximity-scaled (≈ 40 tokens of distance), so
 *  same-text matches far apart resolve silently to the nearer one. */
const AMBIGUITY_MARGIN = 0.02;

export interface QuoteCandidate {
  from: number;
  to: number;
  /** Proximity-weighted score (ranking). */
  score: number;
  /** Pure text-similarity component (comparability). */
  base: number;
}
type Candidate = QuoteCandidate;

function scanTrack(
  tokens: TokenSpan[],
  qWords: string[],
  cursorPos: number,
  maxAvgDistance: number,
): Candidate[] {
  if (tokens.length < qWords.length) return [];
  let cursorTok = tokens.length;
  for (let i = 0; i < tokens.length; i++) {
    if ((tokens[i] as TokenSpan).from >= cursorPos) {
      cursorTok = i;
      break;
    }
  }
  const out: Candidate[] = [];
  for (let i = 0; i + qWords.length <= tokens.length; i++) {
    let dist = 0;
    for (let k = 0; k < qWords.length; k++) {
      dist += wordDistance(qWords[k] as string, (tokens[i + k] as TokenSpan).norm);
      if (dist / qWords.length > maxAvgDistance) break;
    }
    const base = dist / qWords.length;
    if (base > maxAvgDistance) continue;
    const tokDelta = i - cursorTok;
    const proximity =
      tokDelta >= 0
        ? tokDelta * PROXIMITY_PENALTY
        : -tokDelta * PROXIMITY_PENALTY + BACKWARD_OFFSET;
    out.push({
      from: (tokens[i] as TokenSpan).from,
      to: (tokens[i + qWords.length - 1] as TokenSpan).to,
      score: base + proximity,
      base,
    });
  }
  return out;
}

export interface FindQuoteOptions {
  /** Restrict the token scan to this document range. */
  from?: number;
  to?: number;
  /** Override the per-word fuzziness ceiling (default MAX_AVG_DISTANCE). */
  maxAvgDistance?: number;
}

/** All distinct candidate spans for a quote, best-first (score =
 *  text similarity + proximity weighting; `base` carries similarity
 *  alone for comparability decisions). */
export function quoteCandidates(
  doc: PMNode,
  quote: string,
  cursorPos: number,
  opts: FindQuoteOptions = {},
): QuoteCandidate[] {
  const qWords = mergeSpokenNumbers(quote.split(/\s+/).map(normalizeWord).filter(Boolean));
  if (!qWords.length) return [];
  const from = opts.from ?? 0;
  const to = opts.to ?? doc.content.size;
  const maxAvg = opts.maxAvgDistance ?? MAX_AVG_DISTANCE;

  // Both hyphen tracks; identical-span duplicates collapse to best score.
  const candidates = [
    ...scanTrack(collectTokens(doc, 'joined', from, to), qWords, cursorPos, maxAvg),
    ...scanTrack(collectTokens(doc, 'split', from, to), qWords, cursorPos, maxAvg),
  ];
  candidates.sort((a, b) => a.score - b.score);

  // Greedy non-overlap selection: the two hyphen tracks (and shifted
  // windows) produce many overlapping spans of the same hit — keep only
  // the best-scoring span of each distinct location.
  const distinct: Candidate[] = [];
  for (const c of candidates) {
    if (distinct.every((k) => c.to <= k.from || c.from >= k.to)) distinct.push(c);
    if (distinct.length >= 8) break;
  }
  return distinct;
}

export function findQuote(
  doc: PMNode,
  quote: string,
  cursorPos: number,
  opts: FindQuoteOptions = {},
): AlignResult {
  const distinct = quoteCandidates(doc, quote, cursorPos, opts);
  if (!distinct.length) return { status: 'none' };
  const best = distinct[0] as Candidate;
  const runnerUp = distinct[1];
  if (runnerUp && runnerUp.score - best.score < AMBIGUITY_MARGIN) {
    // The margin decides WHETHER to disambiguate; the badge list then
    // shows every distinct comparable match (max 6 — the `pick` grammar
    // ceiling — nearest-first by score), not just those inside the margin.
    return {
      status: 'ambiguous',
      candidates: distinct.slice(0, 6).map((c) => ({ from: c.from, to: c.to })),
    };
  }
  return { status: 'match', from: best.from, to: best.to };
}
