/**
 * Command-bar setting toggles. The palette generates a "Toggle <label>"
 * command for every boolean (`kind: 'toggle'`) setting via
 * `toggleableSettingMetas`, so the list tracks the registry automatically.
 * These lock in the derivation: what's included, host/dependency gating, and
 * that every toggle setting is actually a boolean (so a flip is well-defined).
 */

import { describe, it, expect } from 'vitest';
import {
  SettingsStore,
  SETTING_METADATA,
  toggleableSettingMetas,
  cleanToggleLabel,
  toggleCommandName,
  settingSearchName,
  CYCLABLE_SETTINGS,
  cyclableSettings,
  nextCycleValue,
  cycleCommandName,
  type Settings,
} from '../../src/editor/settings.js';

const mkEnv = (over: { hostKind?: string; isWindows?: boolean; store?: SettingsStore } = {}) => {
  const store = over.store ?? new SettingsStore();
  return {
    hostKind: over.hostKind ?? 'electron',
    isWindows: over.isWindows ?? false,
    get: (k: keyof Settings) => store.get(k),
  };
};

describe('toggleableSettingMetas', () => {
  it('every kind:"toggle" setting is a real boolean (flip is well-defined)', () => {
    const store = new SettingsStore();
    for (const m of SETTING_METADATA.filter((x) => x.kind === 'toggle')) {
      expect(typeof store.get(m.key), `${String(m.key)} default`).toBe('boolean');
    }
  });

  it('returns only toggle settings and excludes search-hidden ones', () => {
    const metas = toggleableSettingMetas(mkEnv());
    expect(metas.length).toBeGreaterThan(30);
    expect(metas.every((m) => m.kind === 'toggle')).toBe(true);
    const keys = metas.map((m) => String(m.key));
    expect(keys).toContain('smartQuotes');
    expect(keys).toContain('editorSpellcheck');
    // kind:'toggle' but searchHidden — must not become a command.
    expect(keys).not.toContain('cardCutterMorphologyShaving');
  });

  it('honors host gating (electronOnly / windowsOnly / webOnly)', () => {
    const el = toggleableSettingMetas(mkEnv({ hostKind: 'electron', isWindows: false })).map((m) =>
      String(m.key),
    );
    const web = toggleableSettingMetas(mkEnv({ hostKind: 'browser' })).map((m) => String(m.key));
    const win = toggleableSettingMetas(mkEnv({ hostKind: 'electron', isWindows: true })).map((m) =>
      String(m.key),
    );
    expect(el).toContain('pairingEnabled'); // electronOnly → present on electron
    expect(web).not.toContain('pairingEnabled'); // hidden on web
    expect(el).not.toContain('flowHostOnLaunch'); // windowsOnly → hidden off Windows
    expect(win).toContain('flowHostOnLaunch'); // present on Windows
  });

  it('hides a dependsOn toggle while its parent is off, shows it when on', () => {
    const store = new SettingsStore();
    store.set('createReferenceIncludeHeading', false);
    expect(
      toggleableSettingMetas(mkEnv({ store })).map((m) => String(m.key)),
    ).not.toContain('createReferenceHeadingBold');

    store.set('createReferenceIncludeHeading', true);
    expect(
      toggleableSettingMetas(mkEnv({ store })).map((m) => String(m.key)),
    ).toContain('createReferenceHeadingBold');
  });
});

describe('toggle command labels', () => {
  it('strips a redundant leading verb and re-capitalizes', () => {
    expect(cleanToggleLabel('Enable AI features')).toBe('AI features');
    expect(cleanToggleLabel('Enable card sharing')).toBe('Card sharing');
    expect(cleanToggleLabel('Show undo / redo buttons')).toBe('Undo / redo buttons');
    expect(cleanToggleLabel('Include the FOR REFERENCE heading')).toBe('FOR REFERENCE heading');
    expect(cleanToggleLabel('Use Gray-50% body text')).toBe('Gray-50% body text');
  });

  it('leaves labels without a leading verb untouched', () => {
    expect(cleanToggleLabel('Editor spellcheck')).toBe('Editor spellcheck');
    expect(cleanToggleLabel('Steady text cursor (no blinking)')).toBe(
      'Steady text cursor (no blinking)',
    );
    // "use" mid-label must not be stripped — only a leading verb is.
    expect(cleanToggleLabel('F3 condense: use pilcrows')).toBe('F3 condense: use pilcrows');
  });

  it('prefixes Create Reference toggles and cleans the rest', () => {
    const bySrcKey = (k: string) => SETTING_METADATA.find((m) => m.key === k)!;
    expect(toggleCommandName(bySrcKey('createReferenceHeadingBold'))).toBe(
      'Toggle Create Reference: Bold heading',
    );
    expect(toggleCommandName(bySrcKey('createReferenceIncludeHeading'))).toBe(
      'Toggle Create Reference: FOR REFERENCE heading',
    );
    expect(toggleCommandName(bySrcKey('smartQuotes'))).toBe('Toggle Smart quotes');
    expect(toggleCommandName(bySrcKey('aiFeaturesEnabled'))).toBe('Toggle AI features');
  });

  it('settingSearchName prefixes context-free sections but keeps the real label', () => {
    const bySrcKey = (k: string) => SETTING_METADATA.find((m) => m.key === k)!;
    // Create Reference sub-settings — the direct-search rows get the same
    // context as the Toggle commands, but the label is NOT verb-stripped
    // (it matches the dialog).
    expect(settingSearchName(bySrcKey('createReferenceHeadingBold'))).toBe(
      'Create Reference: Bold heading',
    );
    expect(settingSearchName(bySrcKey('createReferenceIncludeHeading'))).toBe(
      'Create Reference: Include the FOR REFERENCE heading',
    );
    // Standardize exceptions — same contextless problem, same fix.
    expect(settingSearchName(bySrcKey('standardizeHighlightException'))).toBe(
      'Standardize exceptions: Highlighting exception',
    );
    // A self-contained section is left alone.
    expect(settingSearchName(bySrcKey('smartQuotes'))).toBe('Smart quotes');
    expect(settingSearchName(bySrcKey('editorSpellcheck'))).toBe('Editor spellcheck');
  });
});

describe('cyclable settings', () => {
  it('every cyclable setting is real, and every listed value is valid', () => {
    for (const c of CYCLABLE_SETTINGS) {
      const meta = SETTING_METADATA.find((m) => m.key === c.key);
      expect(meta, `${String(c.key)} in registry`).toBeDefined();
      expect(c.values.length, `${String(c.key)} value count`).toBeGreaterThanOrEqual(2);
      const store = new SettingsStore();
      // Each listed value must survive sanitize (i.e. be a real domain value),
      // else the cycle command would set something that gets reset.
      for (const v of c.values) {
        store.set(c.key, v.value as never);
        expect(store.get(c.key), `${String(c.key)} = ${v.value}`).toBe(v.value);
      }
      // The default must be one of the listed values, so the current-value
      // label and the "next" computation always resolve.
      const def = new SettingsStore().get(c.key);
      expect(c.values.map((v) => v.value), `${String(c.key)} default listed`).toContain(def);
    }
  });

  it('nextCycleValue advances and wraps', () => {
    const iconSet = CYCLABLE_SETTINGS.find((c) => c.key === 'iconSet')!;
    expect(nextCycleValue(iconSet, 'modern').value).toBe('classic');
    expect(nextCycleValue(iconSet, 'classic').value).toBe('modern'); // wrap
    // Unknown current value falls back to the first entry.
    expect(nextCycleValue(iconSet, 'bogus').value).toBe(iconSet.values[0]!.value);
  });

  it('gates on host + dependency like toggles', () => {
    const mk = (over: { isWindows?: boolean; store?: SettingsStore } = {}) => {
      const store = over.store ?? new SettingsStore();
      return { hostKind: 'electron', isWindows: over.isWindows ?? false, get: (k: keyof Settings) => store.get(k) };
    };
    const keys = () => cyclableSettings(mk()).map((e) => String(e.setting.key));
    expect(keys()).toContain('iconSet');
    expect(keys()).toContain('headingMode');

    // multiDocLayoutMode dependsOn multiDocWorkspace.
    const store = new SettingsStore();
    store.set('multiDocWorkspace', false);
    expect(cyclableSettings(mk({ store })).map((e) => String(e.setting.key))).not.toContain(
      'multiDocLayoutMode',
    );
    store.set('multiDocWorkspace', true);
    expect(cyclableSettings(mk({ store })).map((e) => String(e.setting.key))).toContain(
      'multiDocLayoutMode',
    );
  });

  it('names cycle commands from the cleaned label', () => {
    const meta = SETTING_METADATA.find((m) => m.key === 'iconSet')!;
    expect(cycleCommandName(meta)).toBe('Cycle Icon style');
  });
});
