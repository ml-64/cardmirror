/**
 * Dictation post-processing (SPEC-voice.md §7): dash system, spoken
 * punctuation, sentence capitalization.
 */

import { describe, expect, it } from 'vitest';
import {
  transformDictation,
  capitalizeForContext,
} from '../../src/editor/voice/dictation-text.js';

describe('dictation dashes', () => {
  it('bare "dash" uses the configured glyph, unspaced joins words', () => {
    expect(transformDictation('deterrence dash fails', 'em')).toBe('deterrence—fails');
    expect(transformDictation('deterrence dash fails', 'em-spaced')).toBe('deterrence — fails');
    expect(transformDictation('a dash b', 'double')).toBe('a--b');
  });

  it('explicit names bypass the setting', () => {
    expect(transformDictation('a m dash b', 'hyphen')).toBe('a—b');
    expect(transformDictation('a n dash spaced b', 'em')).toBe('a – b');
    expect(transformDictation('a triple dash b', 'em')).toBe('a---b');
    expect(transformDictation('re hyphen search', 'em')).toBe('re-search');
  });
});

describe('dictation punctuation and capitalization', () => {
  it('attaches terminal punctuation to the preceding word', () => {
    expect(transformDictation('extinction comes first period', 'em')).toBe(
      'extinction comes first.',
    );
    expect(transformDictation('first comma second comma third', 'em')).toBe(
      'first, second, third',
    );
  });

  it('handles question marks and quotes', () => {
    expect(transformDictation('why question mark', 'em')).toBe('why?');
    expect(transformDictation('he said open quote never close quote', 'em')).toBe(
      'he said “never”',
    );
  });

  it('capitalizes after sentence enders within a segment', () => {
    expect(transformDictation('it fails period the impact is real', 'em')).toBe(
      'it fails. The impact is real',
    );
  });

  it('capitalizes standalone i', () => {
    expect(transformDictation('i think i agree', 'em')).toBe('I think I agree');
  });
});

describe('segment-start capitalization', () => {
  it('capitalizes at block start and after sentence enders', () => {
    expect(capitalizeForContext('the impact', '')).toBe('The impact');
    expect(capitalizeForContext('the impact', 'It fails. ')).toBe('The impact');
  });

  it('leaves mid-sentence continuations alone', () => {
    expect(capitalizeForContext('and reassure allies', 'transfers deter aggression ')).toBe(
      'and reassure allies',
    );
  });
});
