/**
 * `please <command name>` matching (SPEC-voice.md §5): labels, aliases,
 * fuzzy slips, partial names, and rejection of nonsense.
 */

import { describe, expect, it } from 'vitest';
import { matchCommandName } from '../../src/editor/voice/please-match.js';

describe('please command matching', () => {
  it('matches exact labels', () => {
    expect(matchCommandName('shrink card text')?.id).toBe('shrink');
  });

  it('matches aliases', () => {
    expect(matchCommandName('clear formatting')?.id).toBe('clearToNormal');
    expect(matchCommandName('unshrink')?.id).toBe('regrow');
    expect(matchCommandName('reader mode')?.id).toBe('toggleReadMode');
  });

  it('matches partial names when unambiguously covered', () => {
    const hit = matchCommandName('read mode');
    expect(hit?.id).toBe('toggleReadMode');
  });

  it('absorbs a fuzzy slip', () => {
    expect(matchCommandName('clear formating')?.id).toBe('clearToNormal');
  });

  it('rejects names with unmatched words', () => {
    expect(matchCommandName('launch the missiles')).toBeNull();
    expect(matchCommandName('')).toBeNull();
  });
});
