/**
 * Karaoke paint reading aligner (SPEC-voice.md §6): exact reading,
 * fuzzy slips, disfluency absorption, small skips, restart handling,
 * and span merging.
 */

import { describe, expect, it } from 'vitest';
import { schema } from '../../src/schema/index.js';
import { collectTokens } from '../../src/editor/voice/align.js';
import { alignReading } from '../../src/editor/voice/paint-align.js';

const TEXT =
  'Security cooperation has historically served as the backbone of deterrence. ' +
  'Critics argue that arms sales fuel regional instability, but the empirical record ' +
  'shows that withdrawal correlates with conflict escalation rather than restraint.';

function makeDoc() {
  return schema.nodes['doc']!.create(null, [
    schema.nodes['paragraph']!.create(null, schema.text(TEXT)),
  ]);
}

function spansText(doc: ReturnType<typeof makeDoc>, spans: Array<{ from: number; to: number }>) {
  return spans.map((s) => doc.textBetween(s.from, s.to));
}

describe('paint reading alignment', () => {
  const doc = makeDoc();
  const tokens = collectTokens(doc, 'joined');

  it('marks exactly the words read, as one merged span', () => {
    const r = alignReading(tokens, 'security cooperation has historically served', 0);
    expect(spansText(doc, r.spans)).toEqual(['Security cooperation has historically served']);
    expect(r.headPos).toBeGreaterThan(0);
  });

  it('absorbs disfluencies without breaking the span', () => {
    const r = alignReading(tokens, 'security um cooperation has uh historically served', 0);
    expect(spansText(doc, r.spans)).toEqual(['Security cooperation has historically served']);
  });

  it('tolerates fuzzy word slips', () => {
    const r = alignReading(tokens, 'security cooperations has historically serve', 0);
    expect(spansText(doc, r.spans)).toEqual(['Security cooperation has historically served']);
  });

  it('skips unread text and resumes (two spans)', () => {
    const r = alignReading(tokens, 'security cooperation arms sales fuel', 0);
    expect(spansText(doc, r.spans)).toEqual(['Security cooperation', 'arms sales fuel']);
  });

  it('does not mark anything for unrelated speech', () => {
    const r = alignReading(tokens, 'completely unrelated chatter zebra', 0);
    expect(r.spans).toEqual([]);
    expect(r.matched).toBe(0);
    expect(r.headPos).toBe(0);
  });

  it('starts from the anchor, not the document top', () => {
    // Anchor past the first sentence: "the" should match the LATER
    // "the empirical record", not the early "the backbone".
    const anchor = TEXT.indexOf('Critics');
    const r = alignReading(tokens, 'the empirical record', anchor);
    expect(spansText(doc, r.spans)).toEqual(['the empirical record']);
    expect(r.spans[0]!.from).toBeGreaterThan(anchor);
  });

  it('handles a stumble-restart without jumping backward', () => {
    // Reader restarts the phrase: earlier words re-spoken after the
    // head has passed them are absorbed, not re-marked behind the head.
    const r = alignReading(tokens, 'critics argue that critics argue that arms sales', 0);
    const joined = spansText(doc, r.spans).join(' ');
    expect(joined).toContain('Critics argue that');
    expect(joined).toContain('arms sales');
    // Head ends after "sales", monotone.
    expect(r.headPos).toBe(TEXT.indexOf('sales') + 'sales'.length + 1);
  });
});
