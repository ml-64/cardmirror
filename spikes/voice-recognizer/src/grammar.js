// Command lexicon compiled from SPEC-voice.md §5, as vosk runtime-grammar phrase lists.

export const PENS = ['underline', 'highlight', 'emphasis', 'cite']
export const COLORS = ['blue', 'green', 'yellow', 'pink', 'orange', 'purple']
export const NUMBERS = [
  'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen',
  'eighteen', 'nineteen', 'twenty',
]

export function commandGrammar() {
  const p = []
  for (const pen of PENS) p.push(`pen ${pen}`)
  for (const c of COLORS) p.push(`pen highlight ${c}`)
  p.push('mark', 'strip', 'strip all')
  for (const pen of PENS) p.push(`again but ${pen}`)
  // Quote-verb prefixes — the quote tail is decoded by the parallel doc-vocab recognizer.
  p.push('go to', 'go after', 'take from', 'take through', 'take back to',
    'fix', 'skip to')
  for (const unit of ['card', 'analytic', 'block', 'hat', 'pocket']) {
    p.push(`next ${unit}`, `last ${unit}`)
  }
  p.push('go tag', 'go cite', 'go body', 'top', 'bottom')
  for (const t of ['card', 'tag', 'cite', 'body', 'analytic', 'unit', 'sentence', 'paragraph']) {
    p.push(`take ${t}`)
  }
  for (const n of NUMBERS) {
    p.push(`left ${n} words`, `right ${n} words`, `up ${n} lines`, `down ${n} lines`,
      `extend left ${n} words`, `extend right ${n} words`, `card ${n}`)
  }
  p.push('pick one', 'pick two', 'pick three', 'pick four', 'cancel')
  p.push('copy', 'cut', 'delete', 'paste')
  p.push('paint', 'start typing', 'retype', 'stop typing', 'stop paint')
  for (const s of ['pocket', 'hat', 'block', 'tag', 'analytic', 'paragraph']) {
    p.push(`make ${s}`)
  }
  p.push('new card', 'set tag', 'set cite')
  p.push('condense', 'expand', 'shrink', 'regrow')
  p.push('scratch that', 'clear last', 'redo that')
  p.push('voice sleep', 'voice wake', 'tray', 'more', 'voice help')
  p.push('[unk]')
  return p
}

export const SLEEP_GRAMMAR = ['voice wake', '[unk]']

// Verbs whose utterances end in a <quote> (spec §4.1) — used to decide when the
// parallel doc-vocab decode supplies the tail.
export const QUOTE_VERBS = [
  'go to', 'go after', 'take from', 'take through', 'take back to',
  'mark', 'delete', 'cut', 'copy', 'fix', 'skip to', 'card', 'take',
]

export function docVocabGrammar(docText) {
  const words = [...new Set(
    docText.toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').split(/\s+/).filter(Boolean),
  )]
  // Quote verbs included so the parallel decoder also tracks the command prefix.
  return [...QUOTE_VERBS, ...words, '[unk]']
}

// Stand-in for viewport text (spec §12 item 4) — wording from the spec's worked example.
export const SAMPLE_DOC = `
Security cooperation has historically served as the backbone of deterrence.
Conventional arms transfers deter aggression by signaling commitment to partners.
The Ukraine case demonstrates that even non allied recipients can anchor extended
deterrence when weapons transfers are timely and sustained. Critics argue that
arms sales fuel regional instability, but the empirical record shows that
withdrawal of security cooperation correlates with conflict escalation rather
than restraint. Great power competitors stand ready to backfill any vacuum the
United States leaves behind.
`
