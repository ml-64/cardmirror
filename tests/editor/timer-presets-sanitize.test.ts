/**
 * Speech presets are four slots; stored settings from before the
 * fourth preset existed hold 3-slot arrays, which must gain their
 * fourth slot from the defaults on load — never crash, never stay
 * short (the panel indexes presets[3] unconditionally).
 */
import { describe, it, expect } from 'vitest';
import { SettingsStore } from '../../src/editor/settings.js';

function presetsAfterImport(raw: unknown): number[] {
  const s = new SettingsStore();
  s.replaceAll({ timerSpeechPresets: raw });
  return s.get('timerSpeechPresets');
}

describe('speech-preset sanitize (fourth slot)', () => {
  it('a stored 3-slot array gains the default fourth slot', () => {
    expect(presetsAfterImport([8, 5, 3])).toEqual([8, 5, 3, 12]);
  });

  it('a 4-slot array round-trips', () => {
    expect(presetsAfterImport([4, 4, 3, 2])).toEqual([4, 4, 3, 2]);
  });

  it('garbage falls back to defaults slot-by-slot', () => {
    expect(presetsAfterImport('nope')).toEqual([3, 6, 9, 12]);
    expect(presetsAfterImport([0, -1, 100, 2])).toEqual([3, 6, 9, 2]);
  });

  it('the fourth-preset toggle defaults off and coerces to boolean', () => {
    const s = new SettingsStore();
    expect(s.get('timerShowFourthPreset')).toBe(false);
    s.replaceAll({ timerShowFourthPreset: 1 });
    expect(s.get('timerShowFourthPreset')).toBe(true);
  });
});
