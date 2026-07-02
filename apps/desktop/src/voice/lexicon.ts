/**
 * The command lexicon (SPEC-voice.md §5, draft 0.6) as a single source
 * of truth: every entry maps a spoken phrase to a verb + typed args.
 * The vosk runtime grammars, the utterance validator, and the parse
 * events are all derived from this table — there is no second list to
 * drift out of sync.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CommandArgs } from './types';

export interface LexiconEntry {
  /** Exact spoken form ("pen underline", "go to", "left three words"). */
  phrase: string;
  /** Semantic verb carried on the parse event. */
  verb: string;
  args?: CommandArgs;
  /** Entry is a prefix whose utterance ends in a spoken-text quote (§4.1). */
  quote?: boolean;
}

export const PENS = ['underline', 'highlight', 'emphasis', 'cite'] as const;
export const COLORS = ['blue', 'green', 'yellow', 'pink', 'orange', 'purple'] as const;
const NUMBER_WORDS = [
  'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen',
  'eighteen', 'nineteen', 'twenty',
] as const;

export function buildLexicon(): LexiconEntry[] {
  const e: LexiconEntry[] = [];

  // Pens & marking
  for (const pen of PENS) e.push({ phrase: `pen ${pen}`, verb: 'pen', args: { pen } });
  for (const color of COLORS) {
    e.push({ phrase: `pen highlight ${color}`, verb: 'pen', args: { pen: 'highlight', color } });
  }
  e.push({ phrase: 'mark', verb: 'mark' });
  e.push({ phrase: 'strip', verb: 'strip' });
  e.push({ phrase: 'strip all', verb: 'stripAll' });
  for (const pen of PENS) e.push({ phrase: `again but ${pen}`, verb: 'againBut', args: { pen } });

  // Quote verbs — the tail is supplied by the parallel doc-vocab decode (§10).
  e.push({ phrase: 'go to', verb: 'goTo', quote: true });
  e.push({ phrase: 'go after', verb: 'goAfter', quote: true });
  e.push({ phrase: 'take from', verb: 'takeFrom', quote: true });
  e.push({ phrase: 'take through', verb: 'takeThrough', quote: true });
  e.push({ phrase: 'take back to', verb: 'takeBackTo', quote: true });
  e.push({ phrase: 'mark', verb: 'markQuote', quote: true });
  e.push({ phrase: 'delete', verb: 'deleteQuote', quote: true });
  e.push({ phrase: 'cut', verb: 'cutQuote', quote: true });
  e.push({ phrase: 'copy', verb: 'copyQuote', quote: true });
  e.push({ phrase: 'fix', verb: 'fix', quote: true });
  e.push({ phrase: 'skip to', verb: 'skipTo', quote: true });
  e.push({ phrase: 'card', verb: 'cardQuote', quote: true });
  e.push({ phrase: 'take', verb: 'takeQuote', quote: true });
  // Command-palette escape hatch (§5, Talon's "please"): the tail is a
  // command NAME, matched renderer-side against the ribbon registry.
  // The renderer ships registry names inside the vocabulary text so the
  // tail can decode.
  e.push({ phrase: 'please', verb: 'please', quote: true });
  // UI interop (0.6.2): drive focused palettes/inputs — synthesized
  // keys and one-shot typing into whatever input has focus.
  for (const key of ['enter', 'tab', 'escape', 'up', 'down', 'left', 'right', 'space', 'backspace']) {
    e.push({ phrase: `press ${key}`, verb: 'pressKey', args: { target: key } });
  }
  e.push({ phrase: 'type', verb: 'typeText', quote: true });

  // Structural navigation
  for (const unit of ['card', 'analytic', 'block', 'hat', 'pocket']) {
    e.push({ phrase: `next ${unit}`, verb: 'next', args: { target: unit } });
    e.push({ phrase: `last ${unit}`, verb: 'last', args: { target: unit } });
  }
  // Text-unit steps (0.6.1): reliable keyboard-free travel as fallback
  // for speak-to-target. "letter", not "char/car" — `next car` is one
  // phoneme from `next card` (prefix-freedom/confusability rule, §10).
  for (const unit of ['word', 'sentence', 'paragraph', 'letter']) {
    e.push({ phrase: `next ${unit}`, verb: 'next', args: { target: unit } });
    e.push({ phrase: `last ${unit}`, verb: 'last', args: { target: unit } });
  }
  e.push({ phrase: 'up a paragraph', verb: 'last', args: { target: 'paragraph' } });
  e.push({ phrase: 'down a paragraph', verb: 'next', args: { target: 'paragraph' } });
  // Jump history (0.6.1): return to where the cursor was before its
  // last jump (voice, mouse, or keyboard — peers, §4.4).
  e.push({ phrase: 'go back', verb: 'goBack' });
  e.push({ phrase: 'back', verb: 'goBack' });
  // Repeat the last navigation/step command (0.6.1). Deliberate
  // prefix-freedom exception vs `again but <pen>` — resolved by
  // utterance segmentation, same as `take` vs `take from` (§10).
  e.push({ phrase: 'again', verb: 'againRepeat' });

  // Composable scopes (0.7, SPEC §4.5 — Cursorless adaptation):
  // ordinals count within each scope's ITERATION container ("take
  // second sentence" = of this paragraph; "take third card" = of this
  // block); `every` fans out across the container; head/tail run from
  // the cursor to the containing scope's start/end.
  const SCOPE_WORDS = [
    'pocket', 'hat', 'block', 'card', 'unit', 'analytic',
    'tag', 'cite', 'body', 'paragraph', 'sentence', 'word',
  ];
  const ORDINALS = [
    'first', 'second', 'third', 'fourth', 'fifth',
    'sixth', 'seventh', 'eighth', 'ninth', 'tenth',
  ];
  for (const scope of SCOPE_WORDS) {
    ORDINALS.forEach((ord, i) => {
      e.push({ phrase: `take ${ord} ${scope}`, verb: 'takeOrdinal', args: { target: scope, n: i + 1 } });
      e.push({ phrase: `go to ${ord} ${scope}`, verb: 'goOrdinal', args: { target: scope, n: i + 1 } });
    });
    e.push({ phrase: `take every ${scope}`, verb: 'takeEvery', args: { target: scope } });
    e.push({ phrase: `mark every ${scope}`, verb: 'markEvery', args: { target: scope } });
    e.push({ phrase: `take head ${scope}`, verb: 'takeHead', args: { target: scope } });
    e.push({ phrase: `take tail ${scope}`, verb: 'takeTail', args: { target: scope } });
  }
  for (const target of ['tag', 'cite', 'body']) {
    e.push({ phrase: `go ${target}`, verb: 'goChild', args: { target } });
  }
  e.push({ phrase: 'top', verb: 'top' });
  e.push({ phrase: 'bottom', verb: 'bottom' });

  // Selection
  for (const target of ['card', 'tag', 'cite', 'body', 'analytic', 'unit', 'sentence', 'paragraph']) {
    e.push({ phrase: `take ${target}`, verb: 'takeNode', args: { target } });
  }
  e.push({ phrase: 'cancel', verb: 'cancel' });

  // Cursor-relative (§4.3)
  // Natural inflections (0.6.1): unit optional, singular for one —
  // live testing showed users say "extend right one", never the rigid
  // "extend right one words".
  NUMBER_WORDS.forEach((word, i) => {
    const n = i + 1;
    const wordUnit = n === 1 ? 'word' : 'words';
    const lineUnit = n === 1 ? 'line' : 'lines';
    for (const dir of ['left', 'right'] as const) {
      e.push({ phrase: `${dir} ${word}`, verb: 'move', args: { dir, n, unit: 'words' } });
      e.push({ phrase: `${dir} ${word} ${wordUnit}`, verb: 'move', args: { dir, n, unit: 'words' } });
      e.push({ phrase: `extend ${dir} ${word}`, verb: 'extend', args: { dir, n, unit: 'words' } });
      e.push({ phrase: `extend ${dir} ${word} ${wordUnit}`, verb: 'extend', args: { dir, n, unit: 'words' } });
    }
    for (const dir of ['up', 'down'] as const) {
      e.push({ phrase: `${dir} ${word} ${lineUnit}`, verb: 'move', args: { dir, n, unit: 'lines' } });
    }
    e.push({ phrase: `card ${word}`, verb: 'cardOrdinal', args: { n } });
    e.push({ phrase: `go to card ${word}`, verb: 'cardOrdinal', args: { n } });
    // Every numbered nav-pane level jumps the same way ("block three").
    // Distinct from the composable-scope form ("go to third block",
    // which counts within the current container): these resolve against
    // the nav panel's visible numbering, doc-wide.
    for (const kind of ['pocket', 'hat', 'block', 'analytic']) {
      e.push({ phrase: `${kind} ${word}`, verb: 'navOrdinal', args: { target: kind, n } });
      e.push({ phrase: `go to ${kind} ${word}`, verb: 'navOrdinal', args: { target: kind, n } });
    }
  });
  // Compound card ordinals 21–99 ("card twenty one") — debate files
  // routinely have far more than twenty cards. Users also naturally
  // prefix with "go to", so both forms exist.
  const TENS: Array<[string, number]> = [
    ['twenty', 20], ['thirty', 30], ['forty', 40], ['fifty', 50],
    ['sixty', 60], ['seventy', 70], ['eighty', 80], ['ninety', 90],
  ];
  for (const [tensWord, tens] of TENS) {
    if (tens > 20) e.push(
      { phrase: `card ${tensWord}`, verb: 'cardOrdinal', args: { n: tens } },
      { phrase: `go to card ${tensWord}`, verb: 'cardOrdinal', args: { n: tens } },
    );
    NUMBER_WORDS.slice(0, 9).forEach((unitWord, i) => {
      const n = tens + i + 1;
      e.push({ phrase: `card ${tensWord} ${unitWord}`, verb: 'cardOrdinal', args: { n } });
      e.push({ phrase: `go to card ${tensWord} ${unitWord}`, verb: 'cardOrdinal', args: { n } });
    });
  }
  for (const dir of ['left', 'right'] as const) {
    e.push({ phrase: `extend ${dir}`, verb: 'extend', args: { dir, n: 1, unit: 'words' } });
    e.push({ phrase: `extend ${dir} word`, verb: 'extend', args: { dir, n: 1, unit: 'words' } });
  }
  for (let n = 1; n <= 6; n++) {
    e.push({ phrase: `pick ${NUMBER_WORDS[n - 1]}`, verb: 'pick', args: { n } });
  }

  // Editing
  e.push({ phrase: 'copy', verb: 'copy' });
  e.push({ phrase: 'cut', verb: 'cut' });
  e.push({ phrase: 'delete', verb: 'delete' });
  e.push({ phrase: 'paste', verb: 'paste' });

  // Modes
  e.push({ phrase: 'paint', verb: 'paint' });
  for (const pen of PENS) e.push({ phrase: `paint ${pen}`, verb: 'paint', args: { pen } });
  e.push({ phrase: 'start typing', verb: 'startTyping' });
  e.push({ phrase: 'retype', verb: 'retype' });

  // Structure (Verbatim parity)
  for (const target of ['pocket', 'hat', 'block', 'tag', 'analytic', 'paragraph']) {
    e.push({ phrase: `make ${target}`, verb: 'make', args: { target } });
  }
  e.push({ phrase: 'new card', verb: 'newCard' });
  e.push({ phrase: 'set tag', verb: 'setTag' });
  e.push({ phrase: 'set cite', verb: 'setCite' });

  // Card operations (0.6 wording: expand/regrow)
  e.push({ phrase: 'condense', verb: 'condense' });
  e.push({ phrase: 'expand', verb: 'expand' });
  e.push({ phrase: 'shrink', verb: 'shrink' });
  e.push({ phrase: 'regrow', verb: 'regrow' });

  // Correction
  e.push({ phrase: 'scratch that', verb: 'scratchThat' });
  e.push({ phrase: 'clear last', verb: 'clearLast' });
  e.push({ phrase: 'redo that', verb: 'redoThat' });

  // Meta
  e.push({ phrase: 'voice sleep', verb: 'voiceSleep' });
  e.push({ phrase: 'voice wake', verb: 'voiceWake' });
  e.push({ phrase: 'tray', verb: 'tray' });
  e.push({ phrase: 'more', verb: 'more' });
  e.push({ phrase: 'voice help', verb: 'voiceHelp' });

  return e;
}

export const RESERVED_DICTATION = ['stop typing', 'voice sleep', 'scratch that', 'new line', 'new paragraph'];
export const RESERVED_PAINT = ['stop paint', 'voice sleep', 'clear last'];
export const SLEEP_GRAMMAR = ['voice wake', '[unk]'];

/** In-paint command grammar (§6): exits, pen switches, nothing else —
 *  everything else spoken in paint is document text being read. */
export function paintEscapeGrammar(): string[] {
  return [...RESERVED_PAINT, ...PENS.map((p) => `pen ${p}`), 'skip to', '[unk]'];
}

/** Vosk runtime grammar for command mode: every spoken form + [unk]. */
export function commandGrammar(lexicon: LexiconEntry[]): string[] {
  return [...new Set(lexicon.map((x) => x.phrase)), '[unk]'];
}

export function escapeGrammar(): string[] {
  return [...RESERVED_DICTATION, '[unk]'];
}

/** Hard cap on grammar phrase count: FST rebuild and decode cost scale
 *  with grammar size. Near-cursor scoping renderer-side keeps real
 *  inputs far below this; the cap is the backstop. */
const MAX_VOCAB_PHRASES = 6000;

/**
 * Document-vocabulary grammar for quote decoding (§12 item 4), built as
 * sliding N-GRAM PHRASES (1–4 words) rather than a bag of words: a
 * bag-of-words grammar gives the decoder no sequence prior, and on a
 * real document it free-associates word salad. With n-gram phrases the
 * decoder can only emit word sequences that actually occur in the text
 * (longer quotes decode as phrase concatenations). N-grams never cross
 * block boundaries — the input uses '\n' as the block separator.
 */
export function docVocabGrammar(lexicon: LexiconEntry[], docText: string): string[] {
  const quoteVerbs = lexicon.filter((x) => x.quote).map((x) => x.phrase);
  const phrases = new Set<string>();
  // Normalize to the model's vocabulary space: curly apostrophes →
  // ascii (the editor produces "don’t"; the model knows "don't"), and
  // diacritics stripped (café → cafe) — otherwise those words silently
  // vanish from the grammar.
  const normalized = docText
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
  // Digit tokens get spoken-word alternates so quotes can say them —
  // "take twenty six" is undecodable when the grammar only holds "26".
  const UNITS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
  const TEENS = ['ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
  const TENS_W = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
  const numberWords = (n: number): string | null => {
    if (n < 10) return UNITS[n] ?? null;
    if (n < 20) return TEENS[n - 10] ?? null;
    if (n < 100) {
      const tens = TENS_W[Math.floor(n / 10)];
      const unit = n % 10;
      return unit ? `${tens} ${UNITS[unit]}` : (tens ?? null);
    }
    return null;
  };

  for (const block of normalized.split('\n')) {
    const words = block.replace(/[^a-z0-9' ]+/g, ' ').split(/\s+/).filter(Boolean);
    for (const w of words) {
      if (/^\d{1,2}$/.test(w)) {
        const spoken = numberWords(parseInt(w, 10));
        if (spoken) phrases.add(spoken);
      }
    }
    for (let n = 1; n <= 4; n++) {
      for (let i = 0; i + n <= words.length; i++) {
        phrases.add(words.slice(i, i + n).join(' '));
        if (phrases.size >= MAX_VOCAB_PHRASES) break;
      }
      if (phrases.size >= MAX_VOCAB_PHRASES) break;
    }
    if (phrases.size >= MAX_VOCAB_PHRASES) break;
  }
  return [...new Set([...quoteVerbs, ...phrases]), '[unk]'];
}

/**
 * Vocab-check (§10): every lexicon word must exist in the model's word
 * list. A miss is a hard error — vosk silently drops OOV words from
 * grammars, and the observed failure mode is an antonym force-fit.
 */
export function assertLexiconInVocabulary(lexicon: LexiconEntry[], modelDir: string): void {
  const wordsFile = path.join(modelDir, 'graph', 'words.txt');
  if (!fs.existsSync(wordsFile)) {
    throw new Error(`voice: model at ${modelDir} has no graph/words.txt — cannot vocab-check the lexicon`);
  }
  const vocab = new Set(
    fs.readFileSync(wordsFile, 'utf8').split('\n').map((line) => line.split(' ')[0]),
  );
  const phrases = [
    ...lexicon.map((x) => x.phrase),
    ...RESERVED_DICTATION,
    ...RESERVED_PAINT,
    ...SLEEP_GRAMMAR,
  ];
  const missing = [
    ...new Set(phrases.flatMap((p) => p.split(' ')).filter((w) => w !== '[unk]' && !vocab.has(w))),
  ];
  if (missing.length) {
    throw new Error(`voice: lexicon words missing from model vocabulary: ${missing.join(', ')}`);
  }
}
