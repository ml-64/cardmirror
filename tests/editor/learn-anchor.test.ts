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
    // Second 'cd' starts at PM pos for offset 6 → 'a'(1).. offset6 char left pos.
    // Verify by text + that it's the later one (from > first occurrence's from).
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
});
