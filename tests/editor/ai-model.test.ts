import { describe, it, expect, afterEach } from 'vitest';
import { resolveAiModel, DEFAULT_MODEL } from '../../src/editor/ai/llm.js';
import { settings } from '../../src/editor/settings.js';

describe('resolveAiModel (custom model override)', () => {
  afterEach(() => settings.set('aiModelOverride', ''));

  it('uses the default when no override is set', () => {
    settings.set('aiModelOverride', '');
    expect(resolveAiModel()).toBe(DEFAULT_MODEL);
  });

  it('uses a well-formed override verbatim', () => {
    settings.set('aiModelOverride', 'claude-opus-4-8');
    expect(resolveAiModel()).toBe('claude-opus-4-8');
  });

  it('reverts to the default on a malformed override', () => {
    for (const bad of ['  ', 'x', 'has space', 'bad/slash']) {
      settings.set('aiModelOverride', bad);
      expect(resolveAiModel(), `bad="${bad}"`).toBe(DEFAULT_MODEL);
    }
  });

  it('trims surrounding whitespace', () => {
    settings.set('aiModelOverride', '  claude-sonnet-4-6  ');
    expect(resolveAiModel()).toBe('claude-sonnet-4-6');
  });
});
