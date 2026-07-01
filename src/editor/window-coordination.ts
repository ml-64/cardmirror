/**
 * Web cross-window coordination over BroadcastChannel — the browser-edition
 * counterpart to the Electron main process, which the desktop build uses as its
 * coordination hub.
 *
 * Powers the multi-pane mode-switch's "ask the other windows to journal their
 * docs and close, then collect what they had open" handshake — the web analogue
 * of Electron's `journalAndCloseOtherWindows` + `reportModeSwitchJournaled` +
 * `closeSelf`. (Later: single-window singleton enforcement and the cross-window
 * same-file guard hang off the same channel.)
 *
 * Design notes:
 *  - A BroadcastChannel delivers a message to every OTHER instance of the same
 *    channel name — INCLUDING other instances in the SAME window. So every
 *    handler ignores messages stamped with its own `WINDOW_ID`.
 *  - Passenger windows report {uid,dirty} only; the doc bytes ride in the shared
 *    journal store (IndexedDB), which the survivor reads after its reload. So the
 *    report is tiny and fast (no serialization) and never races the reload.
 *  - Everything degrades to a graceful no-op where BroadcastChannel is absent.
 */

import type { ModeSwitchDoc } from './mode-switch.js';
import { getElectronHost } from './host/index.js';

const CHANNEL_NAME = 'pmd-window-coord';

/** Stable identity for THIS window, for the session. Shared across every channel
 *  instance this module opens in this window (module-level constant), so a
 *  window can recognize — and ignore — its own broadcasts. */
const WINDOW_ID =
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `w${Math.floor(performance.now())}-${Math.floor(Math.random() * 1e9)}`;

type CoordMsg =
  | { kind: 'coord:ping'; from: string }
  | { kind: 'coord:here'; from: string }
  | { kind: 'mode-switch:please-close'; from: string }
  | { kind: 'mode-switch:report'; from: string; docs: ModeSwitchDoc[] };

function makeChannel(): BroadcastChannel | null {
  try {
    return typeof BroadcastChannel !== 'undefined'
      ? new BroadcastChannel(CHANNEL_NAME)
      : null;
  } catch {
    return null;
  }
}

// How long to listen for peer pongs before deciding who's open.
const PING_WINDOW_MS = 250;
// Hard cap on waiting for slow passengers to report before we proceed anyway.
const REPORT_CAP_MS = 1500;

/** Count the other open windows (their WINDOW_IDs) via a quick ping/pong. */
function pingPeers(channel: BroadcastChannel): Promise<Set<string>> {
  return new Promise((resolve) => {
    const peers = new Set<string>();
    const onMsg = (e: MessageEvent<CoordMsg>): void => {
      const msg = e.data;
      if (msg?.kind === 'coord:here' && msg.from !== WINDOW_ID) peers.add(msg.from);
    };
    channel.addEventListener('message', onMsg);
    channel.postMessage({ kind: 'coord:ping', from: WINDOW_ID } satisfies CoordMsg);
    window.setTimeout(() => {
      channel.removeEventListener('message', onMsg);
      resolve(peers);
    }, PING_WINDOW_MS);
  });
}

/** Broadcast please-close and collect each peer's {uid,dirty} report; resolve as
 *  soon as every counted peer has reported, or at the cap. */
function collectReports(
  channel: BroadcastChannel,
  peers: Set<string>,
): Promise<ModeSwitchDoc[]> {
  return new Promise((resolve) => {
    const collected: ModeSwitchDoc[] = [];
    const reported = new Set<string>();
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      channel.removeEventListener('message', onMsg);
      resolve(collected);
    };
    const onMsg = (e: MessageEvent<CoordMsg>): void => {
      const msg = e.data;
      if (
        msg?.kind === 'mode-switch:report' &&
        msg.from !== WINDOW_ID &&
        !reported.has(msg.from)
      ) {
        reported.add(msg.from);
        collected.push(...msg.docs);
        if ([...peers].every((p) => reported.has(p))) finish();
      }
    };
    channel.addEventListener('message', onMsg);
    channel.postMessage({ kind: 'mode-switch:please-close', from: WINDOW_ID } satisfies CoordMsg);
    window.setTimeout(finish, REPORT_CAP_MS);
  });
}

/**
 * Initiator side of a web mode switch: ask every OTHER window to journal its
 * open doc(s) and close, and return the {uid,dirty} each reported so the caller
 * can fold them into the mode-switch marker. Short-circuits to `[]` when no
 * other window is open (so a lone-window switch never pauses) or when
 * BroadcastChannel is unavailable.
 */
export async function webCloseOtherWindowsForModeSwitch(): Promise<ModeSwitchDoc[]> {
  const channel = makeChannel();
  if (!channel) return [];
  try {
    const peers = await pingPeers(channel);
    if (peers.size === 0) return [];
    return await collectReports(channel, peers);
  } finally {
    channel.close();
  }
}

/**
 * Passenger side: install a listener (once, at boot, on the browser host only —
 * Electron uses its own IPC path) that answers presence pings and, on a
 * please-close, journals this window's open doc(s) via `journalOpenDocs`,
 * reports the {uid,dirty} back to the initiator, and self-closes.
 */
export function installModeSwitchCloseHandler(
  journalOpenDocs: () => Promise<ModeSwitchDoc[]>,
): void {
  if (getElectronHost()) return; // desktop coordinates through main
  const channel = makeChannel();
  if (!channel) return;
  channel.addEventListener('message', (e: MessageEvent<CoordMsg>) => {
    const msg = e.data;
    if (!msg || msg.from === WINDOW_ID) return; // ignore our own broadcasts
    if (msg.kind === 'coord:ping') {
      channel.postMessage({ kind: 'coord:here', from: WINDOW_ID } satisfies CoordMsg);
      return;
    }
    if (msg.kind === 'mode-switch:please-close') {
      void (async (): Promise<void> => {
        let docs: ModeSwitchDoc[] = [];
        try {
          docs = await journalOpenDocs();
        } catch (err) {
          console.warn('Mode-switch journaling failed:', err);
        }
        channel.postMessage({
          kind: 'mode-switch:report',
          from: WINDOW_ID,
          docs,
        } satisfies CoordMsg);
        // Give the report a beat to flush across the channel before this
        // context is torn down, then close (with the stuck-window fallback).
        window.setTimeout(() => {
          closeSelfWithFallback(
            'This document moved to your three-pane window. You can close this window.',
          );
        }, 150);
      })();
    }
  });
}

/**
 * Close this window, with a fallback for the rare case Chrome refuses the
 * self-close (a window is only script-closable as a top-level context with a
 * single history entry). If we're still alive shortly after `window.close()`,
 * cover the (now-stale) content with a dismissible notice rather than leave a
 * duplicate window sitting there.
 */
export function closeSelfWithFallback(message: string): void {
  window.close();
  window.setTimeout(() => {
    if (document.querySelector('[data-pmd-moved-overlay]')) return;
    showMovedOverlay(message);
  }, 500);
}

function showMovedOverlay(message: string): void {
  const overlay = document.createElement('div');
  overlay.setAttribute('data-pmd-moved-overlay', '');
  overlay.style.cssText = [
    'position:fixed',
    'inset:0',
    'z-index:2147483647',
    'display:flex',
    'align-items:center',
    'justify-content:center',
    'padding:24px',
    'background:var(--pmd-c-bg, #fff)',
    'color:var(--pmd-c-fg, #1a1a1a)',
    'font:15px/1.5 system-ui,sans-serif',
    'text-align:center',
  ].join(';');
  const box = document.createElement('div');
  box.style.cssText = 'max-width:32rem';
  const p = document.createElement('p');
  p.textContent = message;
  p.style.cssText = 'margin:0 0 16px';
  const hint = document.createElement('p');
  hint.textContent = 'Close this window with ⌘W (or the window controls).';
  hint.style.cssText = 'margin:0;opacity:.7;font-size:13px';
  box.append(p, hint);
  overlay.append(box);
  document.body.append(overlay);
}
