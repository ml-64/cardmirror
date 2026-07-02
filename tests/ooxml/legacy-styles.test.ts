import { describe, it, expect } from 'vitest';
import {
  legacyRole,
  isUnambiguousLegacy,
  buildLegacyHeadingMap,
} from '../../src/ooxml/legacy-styles.js';
import {
  STYLE_RENAME_MAP,
  TEMPLATE_STYLES,
  COMBINED_STYLE_MAP,
} from '../../src/ooxml/style-clean/template-styles.js';

describe('legacyRole', () => {
  it('classifies by UI name, case-insensitively', () => {
    expect(legacyRole({ name: 'Tags' })).toBe('tag');
    expect(legacyRole({ name: 'tags' })).toBe('tag');
    expect(legacyRole({ name: 'Cards' })).toBe('body');
    expect(legacyRole({ name: 'Cites' })).toBe('cite');
    expect(legacyRole({ name: 'Block Headings' })).toBe('heading');
    expect(legacyRole({ name: 'Debate Underline' })).toBe('char-underline');
    expect(legacyRole({ name: 'Author-Date' })).toBe('char-cite');
  });

  it('falls back to the styleId when the name does not match', () => {
    expect(legacyRole({ id: 'StyleBoldUnderline' })).toBe('char-underline');
    expect(legacyRole({ id: 'Cites' })).toBe('cite');
    expect(legacyRole({ id: 'StyleStyleBold12pt' })).toBe('char-cite');
  });

  it('prefers the name over the id when both match', () => {
    expect(legacyRole({ name: 'Tags', id: 'Cards' })).toBe('tag');
  });

  it('returns undefined for a non-legacy style', () => {
    expect(legacyRole({ name: 'My Custom Style' })).toBeUndefined();
    expect(legacyRole({ id: 'NotALegacyId' })).toBeUndefined();
    expect(legacyRole({})).toBeUndefined();
  });
});

describe('isUnambiguousLegacy', () => {
  it('is true for a legacy style whose name Word does not also use', () => {
    expect(isUnambiguousLegacy({ name: 'Tags' })).toBe(true);
    expect(isUnambiguousLegacy({ name: 'Cards' })).toBe(true);
    expect(isUnambiguousLegacy({ name: 'Debate Underline' })).toBe(true);
  });

  it('is FALSE for a legacy role reached through a built-in Word heading name', () => {
    // "Heading 4" maps to role 'tag', but the name is ambiguous (Word uses it
    // too), so on its own it must not flag a document as legacy.
    expect(isUnambiguousLegacy({ name: 'Heading 4' })).toBe(false);
    expect(isUnambiguousLegacy({ name: 'heading 1' })).toBe(false);
  });

  it('treats an id-only legacy style (no name) as unambiguous', () => {
    expect(isUnambiguousLegacy({ id: 'StyleBoldUnderline' })).toBe(true);
  });

  it('is false for a non-legacy style', () => {
    expect(isUnambiguousLegacy({ name: 'My Custom Style' })).toBe(false);
  });
});

describe('buildLegacyHeadingMap', () => {
  describe('mixed mode (doc already has Verbatim styles → trust outline level)', () => {
    const map = buildLegacyHeadingMap([], true);
    it('maps outline level N → N+1, clamped to 1..5', () => {
      expect(map(0)).toBe(1);
      expect(map(2)).toBe(3);
      expect(map(3)).toBe(4);
    });
    it('returns 5 for a deep outline level — the value the Heading4 cap clamps', () => {
      // Outline level 4 → 5, but the injected canonical styles top out
      // at Heading4, so the caller clamps it.
      expect(map(4)).toBe(5);
      expect(map(9)).toBe(5);
    });
    it('clamps a negative outline level up to 1', () => {
      expect(map(-1)).toBe(1);
    });
  });

  describe('pure mode (pre-Verbatim → infer depth, deepest → 3)', () => {
    it('ranks the distinct outline levels deepest-first onto [3, 2, 1]', () => {
      const map = buildLegacyHeadingMap([2, 1, 0], false);
      expect(map(2)).toBe(3); // deepest
      expect(map(1)).toBe(2);
      expect(map(0)).toBe(1);
    });
    it('never exceeds 3 even with more than three levels', () => {
      const map = buildLegacyHeadingMap([3, 2, 1, 0], false);
      expect(map(3)).toBe(3);
      expect(map(0)).toBe(1); // ranked beyond [3,2,1] → clamped to 1
    });
    it('maps an unseen level to 1', () => {
      const map = buildLegacyHeadingMap([5], false);
      expect(map(5)).toBe(3); // the only level → deepest rank
      expect(map(0)).toBe(1);
    });
  });
});

describe('COMBINED_STYLE_MAP (the keep/rename whitelist)', () => {
  it('carries the canonical Verbatim heading names + aliases', () => {
    expect(COMBINED_STYLE_MAP['Heading1']).toEqual({ name: 'Heading 1', alias: 'Pocket' });
    expect(COMBINED_STYLE_MAP['Heading4']).toEqual({ name: 'Heading 4', alias: 'Tag' });
    expect(COMBINED_STYLE_MAP['Style13ptBold']).toEqual({ name: 'Style13ptBold', alias: 'Cite' });
    expect(COMBINED_STYLE_MAP['StyleUnderline']).toEqual({ name: 'StyleUnderline', alias: 'Underline' });
    expect(COMBINED_STYLE_MAP['Normal']).toEqual({ name: 'Normal', alias: null });
  });

  it('includes the bundled template styles (e.g. Hyperlink) and excludes junk', () => {
    expect(COMBINED_STYLE_MAP['Hyperlink']).toEqual({ name: 'Hyperlink', alias: null });
    expect(COMBINED_STYLE_MAP['SomeJunkStyle']).toBeUndefined();
  });

  it('is exactly the union of the rename map and the template styles', () => {
    expect(Object.keys(COMBINED_STYLE_MAP).sort()).toEqual(
      [...new Set([...Object.keys(STYLE_RENAME_MAP), ...Object.keys(TEMPLATE_STYLES)])].sort(),
    );
  });
});
