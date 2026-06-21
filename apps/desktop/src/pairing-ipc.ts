/**
 * Pairing main-process bridge — cross-machine card sharing.
 *
 * The main process is the single owner of:
 *   - the X25519 keypair (this machine's identity; private key in userData,
 *     never exposed to a renderer or the relay);
 *   - the relay base URL + bearer token (baked build constants, env-
 *     overridable; never exposed to a renderer);
 *   - the background receive poller (one loop, shared by all windows);
 *   - the inbox of received cards (persisted to userData, broadcast to
 *     every window via `pairing:inbox-changed`).
 *
 * END-TO-END ENCRYPTED: every card is sealed to the recipient's public key
 * (sealed box; see pairing-crypto.ts) before it leaves this process, and the
 * host sees only an opaque ciphertext bundle plus a hashed routing code. The
 * sender identity, group label, schema version, and card content all live
 * INSIDE the ciphertext — the relay host can interpret none of it.
 *
 * Addressing is DIRECTED: each machine polls only its own routing code and
 * never sends to itself, so there is no self-echo and no delete race.
 *
 * The relay contract here is identical to the scouting-assistant `/relay` API,
 * so pointing at production is a one-line change to RELAY_URL.
 */

import { app, BrowserWindow, ipcMain } from 'electron';
import { gzipSync } from 'node:zlib';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createPairingKeystore, routingId, type PairingKeystore, type SealedBundle } from './pairing-crypto.js';

/** Baked relay config. A packaged GUI app does NOT inherit shell env, so
 *  these compile in; env vars still override for dev (`desktop:dev` can
 *  point at a local mock or a staging relay).
 *
 *  DEV DEFAULT points at the local mock relay (`dev/mock-relay`). Switch
 *  the default to the scouting-assistant URL — e.g.
 *  `https://scouting-assistant.up.railway.app/relay` — when that backend
 *  ships, and bake the real RELAY_TOKEN here. */
const RELAY_URL = process.env.PAIRING_RELAY_URL || 'http://127.0.0.1:3200';
const RELAY_TOKEN = process.env.PAIRING_TOKEN || 'dev-pairing-token';

interface PairingConfig {
  enabled: boolean;
  displayName: string;
  schemaVersion: string;
  pollSeconds: number;
}

interface SendItem {
  label: string;
  type: string;
  sliceJson: unknown;
}

/** The plaintext sealed inside each message — never visible to the host. */
interface InnerPayload {
  schemaVersion?: string;
  senderCode?: string;
  senderName?: string;
  via?: string;
  item?: SendItem;
}

interface InboxItem {
  id: string;
  label: string;
  type: string;
  sliceJson: unknown;
  senderName: string;
  senderCode: string;
  via?: string;
  receivedAt: number;
  read: boolean;
}

/** What the relay returns per stored message: routing metadata in the clear
 *  plus the opaque encrypted bundle. */
interface RelayMessage extends Partial<SealedBundle> {
  msgId: string;
  recipientCode?: string;
  sentAt?: number;
  receivedAt?: number;
}

let config: PairingConfig = {
  enabled: false,
  displayName: '',
  schemaVersion: 'unknown',
  pollSeconds: 30,
};
let pollTimer: ReturnType<typeof setInterval> | null = null;
let polling = false;
/** msgIds already handled this session — guards against re-processing if a
 *  DELETE failed (the message would still be on the relay next poll). */
const consumed = new Set<string>();

// ── Keystore (this machine's X25519 identity) ────────────────────────

let keystore: PairingKeystore | null = null;
function ks(): PairingKeystore {
  if (!keystore) {
    keystore = createPairingKeystore(path.join(app.getPath('userData'), 'pairing-keys.json'));
  }
  return keystore;
}

// ── Inbox state (persisted, broadcast) ───────────────────────────────

let inbox: InboxItem[] = [];
let inboxLoaded = false;

function inboxPath(): string {
  return path.join(app.getPath('userData'), 'pairing-inbox.json');
}

async function ensureInboxLoaded(): Promise<void> {
  if (inboxLoaded) return;
  inboxLoaded = true;
  try {
    const text = await fs.readFile(inboxPath(), 'utf8');
    const parsed = JSON.parse(text);
    if (parsed && Array.isArray(parsed.items)) {
      inbox = parsed.items.filter(
        (it: unknown): it is InboxItem =>
          !!it && typeof it === 'object' && typeof (it as InboxItem).id === 'string',
      );
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn('[pairing] Failed to read pairing-inbox.json:', err);
    }
    inbox = [];
  }
}

let inboxWriteTail: Promise<void> = Promise.resolve();
function persistInbox(): Promise<void> {
  const snapshot = inbox;
  inboxWriteTail = inboxWriteTail.catch(() => {}).then(async () => {
    const finalPath = inboxPath();
    const tmpPath = `${finalPath}.tmp`;
    await fs.writeFile(tmpPath, JSON.stringify({ version: 1, items: snapshot }));
    await fs.rename(tmpPath, finalPath);
  });
  return inboxWriteTail;
}

function broadcastInbox(): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('pairing:inbox-changed', inbox);
  }
}

function broadcastVersionMismatch(partnerVersion: string, localVersion: string): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) {
      w.webContents.send('pairing:version-mismatch', { partnerVersion, localVersion });
    }
  }
}

// ── Relay HTTP ───────────────────────────────────────────────────────

function authHeaders(extra?: Record<string, string>): Record<string, string> {
  return { Authorization: `Bearer ${RELAY_TOKEN}`, ...extra };
}

function deleteMessage(msgId: string): void {
  const url = `${RELAY_URL}/messages/${encodeURIComponent(msgId)}`;
  fetch(url, { method: 'DELETE', headers: authHeaders() }).catch((err) => {
    console.warn(`[pairing] DELETE ${msgId} failed:`, err);
  });
}

/** One poll cycle: pull our mailbox, decrypt, convert + dedupe + delete. */
async function pollOnce(): Promise<void> {
  if (polling || !config.enabled) return;
  polling = true;
  try {
    await ensureInboxLoaded();
    const url = `${RELAY_URL}/messages?recipient=${encodeURIComponent(ks().ownRoutingId())}`;
    const res = await fetch(url, { method: 'GET', headers: authHeaders() });
    if (!res.ok) {
      console.warn(`[pairing] GET inbox returned ${res.status}`);
      return;
    }
    const data = (await res.json()) as { messages?: RelayMessage[] };
    const messages = data.messages ?? [];
    if (messages.length === 0) return;

    let changed = false;
    for (const m of messages) {
      if (!m || typeof m.msgId !== 'string') continue;
      if (consumed.has(m.msgId)) continue;
      consumed.add(m.msgId);

      // Decrypt the sealed bundle with our private key. A failure means it
      // wasn't really for us (or was sealed to a stale key of ours) — drop it.
      if (!m.epk || !m.iv || !m.ct || !m.tag) {
        deleteMessage(m.msgId);
        continue;
      }
      let inner: InnerPayload;
      try {
        inner = ks().open({ epk: m.epk, iv: m.iv, ct: m.ct, tag: m.tag }) as InnerPayload;
      } catch {
        console.warn('[pairing] could not decrypt a message; dropping');
        deleteMessage(m.msgId);
        continue;
      }

      // Cross-version guard (the version travels inside the ciphertext): a
      // partner on a different app version may have an incompatible slice
      // schema. Drop it, tell the UI, clear it from the relay.
      const partnerVersion = inner.schemaVersion || 'unknown';
      if (partnerVersion !== config.schemaVersion) {
        console.log(
          `[pairing] dropping card from a different version: ` +
            `partner=${partnerVersion} local=${config.schemaVersion}`,
        );
        broadcastVersionMismatch(partnerVersion, config.schemaVersion);
        deleteMessage(m.msgId);
        continue;
      }

      const item = inner.item;
      if (!item || typeof item !== 'object') {
        deleteMessage(m.msgId);
        continue;
      }
      // Dedupe by source msgId so a failed DELETE can't double-add.
      const id = `rx-${m.msgId}`;
      if (!inbox.some((it) => it.id === id)) {
        inbox = [
          ...inbox,
          {
            id,
            label: typeof item.label === 'string' ? item.label : 'Card',
            type: typeof item.type === 'string' ? item.type : '',
            sliceJson: item.sliceJson,
            senderName: typeof inner.senderName === 'string' ? inner.senderName : '',
            senderCode: typeof inner.senderCode === 'string' ? inner.senderCode : '',
            via: typeof inner.via === 'string' && inner.via ? inner.via : undefined,
            receivedAt: Date.now(),
            read: false,
          },
        ];
        changed = true;
      }
      deleteMessage(m.msgId);
    }

    if (changed) {
      broadcastInbox();
      await persistInbox();
    }
  } catch (err) {
    console.warn('[pairing] poll error:', err);
  } finally {
    polling = false;
  }
}

function applyPoller(): void {
  if (pollTimer !== null) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  if (config.enabled) {
    const ms = Math.max(5, config.pollSeconds) * 1000;
    console.log(`[pairing] poller on: every ${ms / 1000}s for ${ks().ownRoutingId()}`);
    void pollOnce();
    pollTimer = setInterval(() => void pollOnce(), ms);
  } else {
    console.log('[pairing] poller off');
  }
}

// ── IPC ──────────────────────────────────────────────────────────────

export function registerPairingIpc(): void {
  // Configure returns this machine's public CODE (its X25519 public key), so
  // the renderer can display it and the user can share it. The private key
  // stays in main.
  ipcMain.handle(
    'host:pairing-configure',
    (_event, cfg: Partial<PairingConfig>): { ownCode: string } => {
      config = {
        enabled: !!cfg?.enabled,
        displayName: typeof cfg?.displayName === 'string' ? cfg.displayName : '',
        schemaVersion: typeof cfg?.schemaVersion === 'string' ? cfg.schemaVersion : 'unknown',
        pollSeconds:
          typeof cfg?.pollSeconds === 'number' && Number.isFinite(cfg.pollSeconds)
            ? cfg.pollSeconds
            : 30,
      };
      // Only materialize a keypair once the user actually turns sharing on,
      // so a fresh install that never enables it writes no key file.
      const ownCode = config.enabled ? ks().ownPublicCode() : '';
      applyPoller();
      return { ownCode };
    },
  );

  // Mint a fresh keypair (invalidates the old code for partners). Returns the
  // new public code and re-points the poller at the new routing code.
  ipcMain.handle('host:pairing-regenerate-key', (): { ownCode: string } => {
    const ownCode = ks().regenerate();
    consumed.clear();
    applyPoller();
    return { ownCode };
  });

  ipcMain.handle(
    'host:pairing-send',
    async (
      _event,
      payload: { recipientCodes: string[]; item: SendItem; via?: string },
    ): Promise<{ ok: number; fail: number }> => {
      const targets = Array.isArray(payload?.recipientCodes)
        ? Array.from(new Set(payload.recipientCodes.filter((c) => typeof c === 'string' && c)))
        : [];
      if (targets.length === 0 || !payload?.item) {
        return { ok: 0, fail: targets.length };
      }
      const senderCode = ks().ownPublicCode();
      let ok = 0;
      let fail = 0;
      await Promise.all(
        targets.map(async (recipientPublicCode) => {
          try {
            // Seal everything-but-routing to the recipient's public key.
            const inner: InnerPayload = {
              schemaVersion: config.schemaVersion,
              senderCode,
              senderName: config.displayName,
              via: payload.via,
              item: {
                label: payload.item.label,
                type: payload.item.type,
                sliceJson: payload.item.sliceJson,
              },
            };
            const bundle = ks().seal(inner, recipientPublicCode);
            const body = {
              v: 1 as const,
              recipientCode: routingId(recipientPublicCode),
              sentAt: Date.now(),
              ...bundle,
            };
            const gz = gzipSync(Buffer.from(JSON.stringify(body), 'utf8'));
            const res = await fetch(`${RELAY_URL}/messages`, {
              method: 'POST',
              headers: authHeaders({
                'Content-Type': 'application/json',
                'Content-Encoding': 'gzip',
              }),
              body: gz,
            });
            if (res.ok) ok++;
            else {
              fail++;
              console.warn(`[pairing] POST returned ${res.status}`);
            }
          } catch (err) {
            fail++;
            console.warn('[pairing] send failed:', err);
          }
        }),
      );
      return { ok, fail };
    },
  );

  ipcMain.handle('host:pairing-inbox-list', async () => {
    await ensureInboxLoaded();
    return inbox;
  });

  ipcMain.handle('host:pairing-inbox-remove', async (_event, id: string) => {
    if (typeof id !== 'string' || !id) return;
    await ensureInboxLoaded();
    const next = inbox.filter((it) => it.id !== id);
    if (next.length === inbox.length) return;
    inbox = next;
    broadcastInbox();
    await persistInbox();
  });

  ipcMain.handle('host:pairing-inbox-clear', async () => {
    await ensureInboxLoaded();
    if (inbox.length === 0) return;
    inbox = [];
    broadcastInbox();
    await persistInbox();
  });

  ipcMain.handle('host:pairing-inbox-mark-read', async () => {
    await ensureInboxLoaded();
    if (!inbox.some((it) => !it.read)) return;
    inbox = inbox.map((it) => (it.read ? it : { ...it, read: true }));
    broadcastInbox();
    await persistInbox();
  });
}
