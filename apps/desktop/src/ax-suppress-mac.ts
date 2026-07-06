/**
 * macOS prong of the renderer-accessibility crash fix.
 *
 * Electron 42 / Chromium 148 crashes deterministically in Blink's accessibility
 * serialization (blink::AXBlockFlowData::ComputeNeighborOnLine) whenever the web
 * accessibility tree is built. The `--disable-renderer-accessibility` switch
 * (appended in main.ts) stops that on Windows/Linux, but on macOS an
 * assistive-tech client setting AXEnhancedUserInterface on the shared
 * NSApplication re-enables the tree behind the switch's back.
 *
 * This module loads native/ax-suppress.dylib and calls its cm_suppress_ax(),
 * which swizzles -[NSApplication accessibilitySetValue:forAttribute:] so those
 * activation attributes are dropped. The swizzled implementation lives entirely
 * in the dylib (plain C, invoked directly by AppKit); koffi is used only for the
 * one outbound cm_suppress_ax() call at startup. A koffi.register JS callback
 * could NOT stand in for the native IMP — AppKit invoking a JS trampoline
 * mid-runloop aborts under V8's control-flow-integrity check.
 *
 * Gated by the caller on the same accessibilityTreeEnabled pref as the switch:
 * when the user opts the tree back on (accepting the crash risk for a screen
 * reader), suppression is skipped. Best-effort — any failure logs and returns
 * false; the render-process-gone recovery still catches a crash that slips
 * through.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { app } from 'electron';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const koffi = require('koffi');

let installed = false;

/** Resolve the packaged (extraResources) or dev path to the dylib. */
function libPath(): string | null {
  const candidates = app.isPackaged
    ? [join(process.resourcesPath, 'native', 'ax-suppress.dylib')]
    : [join(__dirname, '..', 'resources', 'native', 'ax-suppress.dylib')];
  return candidates.find((p) => existsSync(p)) ?? null;
}

/**
 * Install the AppKit accessibility-activation suppressor. No-op off macOS and
 * after the first successful install. Returns whether suppression is active.
 */
export function installMacAccessibilitySuppression(): boolean {
  if (process.platform !== 'darwin' || installed) return installed;

  const p = libPath();
  if (!p) {
    console.warn('[cardmirror] ax-suppress dylib not found — AX suppression skipped');
    return false;
  }

  try {
    const lib = koffi.load(p);
    const suppress = lib.func('int cm_suppress_ax()');
    installed = suppress() === 1;
    console.log(`[cardmirror] ax-suppress installed=${installed}`);
    return installed;
  } catch (err) {
    console.error('[cardmirror] ax-suppress failed to load', err);
    return false;
  }
}
