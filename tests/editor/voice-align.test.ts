/**
 * Quote alignment (SPEC-voice.md §4.1): normalization, fuzzy matching,
 * forward-first proximity, numeral equivalence, ambiguity detection.
 */

import { describe, expect, it } from 'vitest';
import { schema } from '../../src/schema/index.js';
import { findQuote, normalizeWord } from '../../src/editor/voice/align.js';

function doc(...texts: string[]) {
  return schema.nodes['doc']!.create(
    null,
    texts.map((t) => schema.nodes['paragraph']!.create(null, schema.text(t))),
  );
}

const D = doc(
  'Security cooperation has historically served as the backbone of deterrence.',
  'Conventional arms transfers deter aggression by signaling commitment.',
  'The 24 partner states rely on weapons transfers for extended deterrence.',
);

function textAt(d: ReturnType<typeof doc>, r: { from: number; to: number }) {
  return d.textBetween(r.from, r.to);
}

describe('voice quote alignment', () => {
  it('normalizes case, punctuation, and number words', () => {
    expect(normalizeWord('Deterrence,')).toBe('deterrence');
    expect(normalizeWord('twenty')).toBe('20');
    expect(normalizeWord("don't")).toBe('dont');
  });

  it('finds an exact phrase', () => {
    const r = findQuote(D, 'backbone of deterrence', 0);
    expect(r.status).toBe('match');
    if (r.status === 'match') expect(textAt(D, r)).toBe('backbone of deterrence');
  });

  it('absorbs a one-word recognition slip (fuzzy word match)', () => {
    const r = findQuote(D, 'signaling commitments', 0); // doc has "commitment"
    expect(r.status).toBe('match');
    if (r.status === 'match') expect(textAt(D, r)).toBe('signaling commitment');
  });

  it('matches spoken number words against digits', () => {
    const r = findQuote(D, 'the twenty four partner states', 0);
    expect(r.status).toBe('match');
    if (r.status === 'match') expect(textAt(D, r)).toContain('24 partner states');
  });

  it('prefers the forward match from the cursor', () => {
    // "transfers" appears in paragraph 2 ("arms transfers") and 3
    // ("weapons transfers"). With the cursor between them, forward wins.
    const para3Start = D.content.size - (D.lastChild?.nodeSize ?? 0);
    const r = findQuote(D, 'transfers', para3Start - 5);
    expect(r.status).toBe('match');
    if (r.status === 'match') expect(r.from).toBeGreaterThan(para3Start - 5);
  });

  it('reports ambiguity when two matches are not separated by margin', () => {
    const twice = doc('the impact is extinction', 'they say the impact is extinction too');
    const r = findQuote(twice, 'impact is extinction', 0);
    expect(r.status).toBe('ambiguous');
    if (r.status === 'ambiguous') expect(r.candidates.length).toBeGreaterThanOrEqual(2);
  });

  it('returns none for text that is not in the document', () => {
    expect(findQuote(D, 'quantum cryptography blockchain', 0).status).toBe('none');
  });

  it('matches hyphenated compounds spoken split or joined', () => {
    const h = doc('the anti-war coalition gained strength');
    expect(findQuote(h, 'anti war coalition', 0).status).toBe('match');
    expect(findQuote(h, 'antiwar coalition', 0).status).toBe('match');
  });
});
