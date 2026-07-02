/**
 * Utterance validation and parse-event construction (SPEC-voice.md §5,
 * §10). The recognizer's grammar constraint is necessary but not
 * sufficient: live decodes produce cross-phrase word salad ("hat pen
 * underline") and force-fits, so every utterance is validated against
 * the lexicon table and confidence-gated before becoming a command.
 */
import type { LexiconEntry } from './lexicon';
import type { CommandArgs } from './types';
import type { FinalResult } from './vosk';

export const DEFAULT_MIN_WORD_CONF = 0.7;

export type CommandParse =
  | { kind: 'command'; verb: string; args: CommandArgs; raw: string }
  | {
      kind: 'rejection';
      reason: 'out-of-grammar' | 'low-confidence' | 'invalid-utterance';
      raw: string;
    };

const stripUnk = (text: string): string =>
  text.replaceAll('[unk]', ' ').replace(/\s+/g, ' ').trim();

const hasUnk = (text: string): boolean => text.includes('[unk]');

function lowConfidence(result: FinalResult, minConf: number): boolean {
  return (result.words ?? []).some(
    (w) => w.word !== '[unk]' && w.conf !== undefined && w.conf < minConf,
  );
}

/** Number-word homophones for card ordinals — decodes routinely render
 *  "forty four" as "for to for" (§4.2.1 fuzzy-number recovery). */
const NUM_WORDS: Record<string, number> = {
  one: 1, won: 1, two: 2, three: 3, four: 4, for: 4, fore: 4, five: 5,
  six: 6, seven: 7, eight: 8, ate: 8, nine: 9, ten: 10, eleven: 11,
  twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30,
  forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};

/** Parse "card <fuzzy number>" (optionally "go to card …", one leading
 *  noise word tolerated). Returns the ordinal or null. */
export function parseCardNumber(text: string): number | null {
  const words = text.replaceAll('[unk]', ' ').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  let i = 0;
  if (words[i] && words[i] !== 'card' && words[i] !== 'go') i++;
  if (words[i] === 'go' && words[i + 1] === 'to') i += 2;
  if (words[i] !== 'card') return null;
  const tail = words.slice(i + 1);
  if (!tail.length || tail.length > 3) return null;

  // 'to'/'too' between/after digits is usually a mangled "-ty".
  const isTy = (w: string | undefined) => w === 'to' || w === 'too';
  const val = (w: string | undefined): number | null =>
    w !== undefined && NUM_WORDS[w] !== undefined ? (NUM_WORDS[w] as number) : null;

  const a = val(tail[0]);
  if (a === null && !isTy(tail[0])) return null;
  if (tail.length === 1) return isTy(tail[0]) ? 2 : a;

  const b = val(tail[1]);
  if (tail.length === 2) {
    if (a !== null && a >= 20 && a % 10 === 0 && b !== null && b >= 1 && b <= 9) return a + b; // "twenty one"
    if (a !== null && a >= 1 && a <= 9 && isTy(tail[1])) return a * 10; // "for to" = forty
    if (a !== null && a >= 1 && a <= 9 && b !== null && b >= 1 && b <= 9) return a * 10 + b; // "four four"
    if (a !== null && b !== null) return null;
    return null;
  }
  // three words: "for to for" = d 'ty' d → d*10 + d
  const c = val(tail[2]);
  if (a !== null && a >= 1 && a <= 9 && isTy(tail[1]) && c !== null && c >= 1 && c <= 9) {
    return a * 10 + c;
  }
  return null;
}

export class CommandParser {
  /** Exact spoken form → entry (non-quote entries win duplicate phrases). */
  private exact = new Map<string, LexiconEntry>();
  /** Quote-verb phrases, longest first so "take back to" beats "take". */
  private quoteVerbs: LexiconEntry[];

  constructor(private lexicon: LexiconEntry[], private minWordConf = DEFAULT_MIN_WORD_CONF) {
    for (const entry of lexicon) {
      if (!entry.quote && !this.exact.has(entry.phrase)) this.exact.set(entry.phrase, entry);
    }
    this.quoteVerbs = lexicon
      .filter((x) => x.quote)
      .sort((a, b) => b.phrase.length - a.phrase.length);
  }

  /** Extract the quote tail following a verb phrase, tolerating one
   *  leading noise word — live decodes prepend a hallucinated "the" to
   *  roughly a third of utterances ("the take egypt…"). */
  private tailAfterVerb(text: string, verbPhrase: string): string | null {
    if (text.startsWith(verbPhrase + ' ')) return text.slice(verbPhrase.length + 1);
    const space = text.indexOf(' ');
    if (space > 0) {
      const rest = text.slice(space + 1);
      if (rest.startsWith(verbPhrase + ' ')) return rest.slice(verbPhrase.length + 1);
    }
    return null;
  }

  /** Last resort: the command grammar heard nothing usable but the
   *  doc-vocab decode carries a complete quote utterance ("take egypt").
   *  Confidence-gated — this path must not turn ambient speech into
   *  selections. */
  private docQuoteFallback(docResult: FinalResult | null): CommandParse | null {
    if (!docResult || lowConfidence(docResult, this.minWordConf)) return null;
    const docText = stripUnk(docResult.text);
    if (!docText) return null;
    for (const qv of this.quoteVerbs) {
      const tail = this.tailAfterVerb(docText, qv.phrase);
      if (tail) {
        return {
          kind: 'command',
          verb: qv.verb,
          args: { ...qv.args, quote: tail },
          raw: `${qv.phrase} ${tail}`,
        };
      }
    }
    return null;
  }

  /**
   * @param cmdResult final result from the command-grammar recognizer
   * @param docResult final result from the parallel doc-vocab recognizer
   */
  parse(cmdResult: FinalResult, docResult: FinalResult | null): CommandParse {
    const heard = stripUnk(cmdResult.text);
    const raw = cmdResult.text || docResult?.text || '';

    if (!heard) {
      return this.docQuoteFallback(docResult) ?? { kind: 'rejection', reason: 'out-of-grammar', raw };
    }
    if (lowConfidence(cmdResult, this.minWordConf)) {
      return { kind: 'rejection', reason: 'low-confidence', raw };
    }

    // Exact full-utterance match — only when the decode had no [unk]
    // residue (a quote utterance like "mark <quote>" decodes as
    // "mark [unk]" and must not collapse to bare `mark`).
    const exact = this.exact.get(heard);
    if (exact && !hasUnk(cmdResult.text)) {
      return { kind: 'command', verb: exact.verb, args: { ...exact.args }, raw };
    }

    // Sleep swallows a trailing phrase (§2.1, from talonhub/community):
    // "voice sleep hey what's up" sleeps immediately and discards the
    // rest — checked before exact match because the tail makes the
    // utterance inexact.
    if (heard === 'voice sleep' || heard.startsWith('voice sleep ')) {
      return { kind: 'command', verb: 'voiceSleep', args: {}, raw: 'voice sleep' };
    }

    // Fuzzy card ordinals before quote verbs ("card" is also a quote
    // verb and would swallow numeric tails as document quotes).
    const cardN = parseCardNumber(heard) ?? parseCardNumber(stripUnk(docResult?.text ?? ''));
    if (cardN !== null) {
      return { kind: 'command', verb: 'cardOrdinal', args: { n: cardN }, raw: `card ${cardN}` };
    }

    // Quote-verb prefix: the tail comes from the parallel doc decode.
    // Both sides tolerate a leading noise word. A verb that matches the
    // command decode but yields no doc tail does NOT end the search —
    // the cmd decode often hallucinates a longer verb ("take through
    // down") while the doc decode carries the shorter one ("take
    // sudan"); keep trying shorter verbs before giving up.
    const docText = stripUnk(docResult?.text ?? '');
    let verbHeardButNoTail = false;
    for (const qv of this.quoteVerbs) {
      const heardMatches =
        heard === qv.phrase ||
        heard.startsWith(qv.phrase + ' ') ||
        this.tailAfterVerb(heard, qv.phrase) !== null;
      if (!heardMatches) continue;
      const tail = this.tailAfterVerb(docText, qv.phrase);
      if (!tail) {
        verbHeardButNoTail = true;
        continue;
      }
      return {
        kind: 'command',
        verb: qv.verb,
        args: { ...qv.args, quote: tail },
        raw: `${qv.phrase} ${tail}`,
      };
    }
    if (verbHeardButNoTail) {
      // Some quote verb was heard but no tail is recoverable from any
      // verb split — reject rather than guess; the tray shows what was
      // heard.
      return this.docQuoteFallback(docResult) ?? { kind: 'rejection', reason: 'invalid-utterance', raw };
    }

    // In-grammar words in a sequence that is no command (word salad) —
    // unless the doc decode carries a clean quote utterance.
    return this.docQuoteFallback(docResult) ?? { kind: 'rejection', reason: 'invalid-utterance', raw };
  }
}

/**
 * Lenient reserved-phrase matching for dictation escapes (§7, §10):
 * tolerate a leading noise word and [unk] residue. The "end"/"and"
 * homophone makes exact equality lose real exits.
 */
export function matchReserved(escapeText: string, reserved: string[]): string | null {
  const heard = stripUnk(escapeText);
  if (!heard) return null;
  for (const phrase of reserved) {
    if (heard === phrase || heard.endsWith(' ' + phrase)) return phrase;
  }
  // Tail-word-alone fallback, WHITELISTED to "typing" only: a generic
  // version would make dictating a lone "paragraph", "line", "that",
  // or "sleep" execute a command instead of inserting the word.
  // "typing" keeps the lenient recall the "end"/"and" homophone
  // requires, and is not a word debaters dictate alone.
  const lastWord = heard.split(' ').at(-1) ?? '';
  if (lastWord === 'typing') {
    const tailMatches = reserved.filter((p) => p.endsWith(' typing'));
    if (tailMatches.length === 1) return tailMatches[0] as string;
  }
  return null;
}
