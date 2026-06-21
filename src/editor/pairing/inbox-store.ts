/**
 * Pairing inbox — the cards other machines have sent you. Backs the
 * Receive pill. Mirrors `quick-cards-store.ts` (dual-backend, reactive,
 * cross-window) but holds RECEIVED cards plus their provenance.
 *
 * Two backends, same surface:
 *   - **Electron**: the canonical list lives in the main process (the
 *     background poller adds to it), persisted to
 *     `{userData}/pairing-inbox.json`; `pairing:inbox-changed` broadcasts
 *     keep every window in sync. Survives reloads (main stays alive) and
 *     restarts (disk).
 *   - **Web (deferred v1)**: `localStorage` + a `storage` listener so the
 *     module is safe to load on the web edition; the web-side poller that
 *     would feed it is a later addition.
 *
 * `read` tracks whether the user has opened the Receive pill since a card
 * arrived — drives the unread badge and the "keep flashing" behavior.
 */

import { getElectronHost } from '../host/index.js';

export interface InboxItem {
  /** Local id minted on receipt — stable identity within this machine. */
  id: string;
  label: string;
  /** Schema node kind (card/tag/block/…), used for the row's type chip. */
  type: string;
  /** `Slice.toJSON()` of the card — parsed only on insert. */
  sliceJson: unknown;
  /** Sender's self-declared display name (may be empty). */
  senderName: string;
  /** Sender's pairing code — used to upgrade the label to your local
   *  nickname when the sender is a known partner. */
  senderCode: string;
  /** Optional group label the sender fanned this out through. */
  via?: string;
  /** Epoch ms this card landed in the inbox. */
  receivedAt: number;
  /** Whether the user has seen it (opened the Receive pill since). */
  read: boolean;
}

type Listener = (items: InboxItem[]) => void;

const STORAGE_KEY = 'pmd-pairing-inbox';

class InboxStore {
  private items: InboxItem[] = [];
  private listeners: Set<Listener> = new Set();
  private hostUnsubscribe: (() => void) | null = null;
  private initialized = false;

  /** Eagerly load from whichever backend is active. Idempotent. */
  async init(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    const electron = getElectronHost();
    if (electron?.pairingInboxList) {
      try {
        this.items = await electron.pairingInboxList();
      } catch {
        this.items = [];
      }
      this.hostUnsubscribe =
        electron.onPairingInboxChanged?.((items) => {
          this.items = items;
          this.fire();
        }) ?? null;
    } else {
      this.items = readLocal();
      window.addEventListener('storage', (e) => {
        if (e.key !== STORAGE_KEY) return;
        this.items = readLocal();
        this.fire();
      });
    }
    this.fire();
  }

  /** Snapshot, newest-last (main/storage order). The UI reverses. */
  list(): InboxItem[] {
    return this.items;
  }

  /** Count of cards the user hasn't seen yet. */
  unreadCount(): number {
    let n = 0;
    for (const it of this.items) if (!it.read) n++;
    return n;
  }

  async remove(id: string): Promise<void> {
    this.items = this.items.filter((it) => it.id !== id);
    const electron = getElectronHost();
    if (electron?.pairingInboxRemove) {
      await electron.pairingInboxRemove(id);
    } else {
      writeLocal(this.items);
    }
    this.fire();
  }

  async clear(): Promise<void> {
    this.items = [];
    const electron = getElectronHost();
    if (electron?.pairingInboxClear) {
      await electron.pairingInboxClear();
    } else {
      writeLocal(this.items);
    }
    this.fire();
  }

  /** Mark every card seen — called when the Receive pill opens. Zeroes
   *  the unread count (and stops a "keep flashing" loop). No-op when
   *  nothing is unread, so opening an all-read pill doesn't churn IPC. */
  async markAllRead(): Promise<void> {
    if (this.unreadCount() === 0) return;
    this.items = this.items.map((it) => (it.read ? it : { ...it, read: true }));
    const electron = getElectronHost();
    if (electron?.pairingInboxMarkAllRead) {
      await electron.pairingInboxMarkAllRead();
    } else {
      writeLocal(this.items);
    }
    this.fire();
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private fire(): void {
    const snapshot = this.items;
    for (const fn of this.listeners) fn(snapshot);
  }
}

function readLocal(): InboxItem[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isInboxItem);
  } catch {
    return [];
  }
}

function writeLocal(items: InboxItem[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
  } catch {
    /* quota / disabled — in-window cache still works */
  }
}

function isInboxItem(e: unknown): e is InboxItem {
  if (!e || typeof e !== 'object') return false;
  const c = e as Record<string, unknown>;
  return (
    typeof c.id === 'string' &&
    typeof c.label === 'string' &&
    typeof c.type === 'string' &&
    typeof c.senderCode === 'string' &&
    typeof c.receivedAt === 'number'
  );
}

export const inboxStore = new InboxStore();
