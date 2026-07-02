/**
 * Learn anchor descriptors — build, re-resolve, disambiguate, break.
 */

import { describe, expect, it } from 'vitest';
import { schema } from '../../src/schema/index.js';
import {
  buildDescriptor,
  resolveDescriptor,
  type AnchorDescriptor,
} from '../../src/editor/learn-anchor.js';

function docOf(text: string) {
  return schema.nodes['doc']!.createChecked(null, [
    schema.nodes['paragraph']!.create(null, schema.text(text)),
  ]);
}

describe('buildDescriptor', () => {
  it('captures quote + context + offset', () => {
    const doc = docOf('abcdef');
    // 'a' left pos = 1; select 'cd' = PM [3, 5).
    const d = buildDescriptor(doc, 3, 5);
    expect(d).toEqual({ quote: 'cd', prefix: 'ab', suffix: 'ef', approxPos: 2 });
  });
});

describe('resolveDescriptor', () => {
  it('round-trips to the same range', () => {
    const doc = docOf('abcdef');
    const d = buildDescriptor(doc, 3, 5);
    const r = resolveDescriptor(doc, d)!;
    expect(doc.textBetween(r.from, r.to)).toBe('cd');
    expect(r.ambiguous).toBe(false);
  });

  it('re-finds the quote after text shifts (edit before it)', () => {
    const d: AnchorDescriptor = { quote: 'cd', prefix: 'ab', suffix: 'ef', approxPos: 2 };
    const shifted = docOf('XYabcdef'); // inserted "XY" before
    const r = resolveDescriptor(shifted, d)!;
    expect(shifted.textBetween(r.from, r.to)).toBe('cd');
  });

  it('disambiguates duplicate quotes by surrounding context', () => {
    const doc = docOf('cd ZZ cd'); // 'cd' at offsets 0 and 6
    // Descriptor for the SECOND occurrence (preceded by "ZZ ").
    const d: AnchorDescriptor = { quote: 'cd', prefix: 'ZZ ', suffix: '', approxPos: 6 };
    const r = resolveDescriptor(doc, d)!;
    // Verify by text, and that it's the later occurrence (from > first's from).
    expect(doc.textBetween(r.from, r.to)).toBe('cd');
    const first: AnchorDescriptor = { quote: 'cd', prefix: '', suffix: ' ZZ', approxPos: 0 };
    const rFirst = resolveDescriptor(doc, first)!;
    expect(r.from).toBeGreaterThan(rFirst.from);
  });

  it('returns null when the quote is gone (broken grounding)', () => {
    expect(resolveDescriptor(docOf('abcdef'), {
      quote: 'zzz',
      prefix: '',
      suffix: '',
      approxPos: 0,
    })).toBeNull();
  });

  it('empty quote never resolves', () => {
    expect(resolveDescriptor(docOf('abc'), { quote: '', prefix: '', suffix: '', approxPos: 0 })).toBeNull();
  });

  it('does not ground on a coincidental hit with unrelated context', () => {
    // Original text was deleted; the quote 'cd' still occurs once, but in
    // surroundings nothing like the stored context → must unanchor, not
    // ground onto it.
    const doc = docOf('the quick brown fox cd jumps over the lazy dog');
    const d: AnchorDescriptor = {
      quote: 'cd',
      prefix: 'evidence that the war powers resolution',
      suffix: 'constrains executive overreach significantly',
      approxPos: 200,
    };
    expect(resolveDescriptor(doc, d)).toBeNull();
  });

  it('still grounds when the quote moved with its surroundings intact', () => {
    const d: AnchorDescriptor = { quote: 'cd', prefix: 'ZZZZ', suffix: 'YYYY', approxPos: 0 };
    const doc = docOf('start ZZZZcdYYYY end'); // relocated; context preserved
    const r = resolveDescriptor(doc, d)!;
    expect(doc.textBetween(r.from, r.to)).toBe('cd');
  });

  it('grounds when only one side of the context survives an edit', () => {
    // Prefix rewritten, suffix intact — one side clearing the bar is enough.
    const d: AnchorDescriptor = { quote: 'cd', prefix: 'oldoldoldold', suffix: 'YYYYYYYY', approxPos: 0 };
    const doc = docOf('brand new text cdYYYYYYYY tail');
    const r = resolveDescriptor(doc, d)!;
    expect(doc.textBetween(r.from, r.to)).toBe('cd');
  });
});
