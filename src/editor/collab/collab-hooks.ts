/**
 * Zero-dependency seams between the always-loaded editor core and the
 * lazily-loaded collab module (which pulls in the Loro wasm — never on
 * the startup path).
 *
 * The transaction tagger runs inside `dispatchTransaction` BEFORE
 * `state.apply`, so metas it sets are visible to every
 * `filterTransaction` (read mode, AI edit coordinator). The active
 * collab module registers a tagger that stamps the sync-origin meta on
 * the Loro binding's remote transactions; with no session active this
 * is a null-check per dispatch.
 *
 * The plugin source lets `buildEditorPlugins` include a live session's
 * binding plugins, and signals that the session owns undo (the CRDT
 * undo manager reverts only this peer's edits — prosemirror-history
 * cannot guarantee that once remote transactions interleave).
 */

import type { Command, Plugin, Transaction } from 'prosemirror-state';

export interface CollabPluginSource {
  /** The `DocRecord.uid` of the ONE document this session owns — the registry
   *  key. Only that document's view receives the binding plugins; every other
   *  pane stays independent (the multi-pane fusion guard), and a window can hold
   *  one session per open doc. */
  ownerUid: string | null;
  /** Binding plugins for the active session (sync, undo, cursors). */
  plugins(): Plugin[];
  /** True while the session owns undo — `history()` is excluded and
   *  Mod-Z / Mod-Y route to `undo` / `redo` below. */
  ownsUndo(): boolean;
  undo: Command;
  redo: Command;
}

let tagger: ((tr: Transaction) => void) | null = null;
// One live session per OWNING doc uid. A multi-pane window can therefore hold
// several independent sessions; each doc's view only ever sees its own.
const pluginSources = new Map<string, CollabPluginSource>();

export function setCollabTransactionTagger(fn: ((tr: Transaction) => void) | null): void {
  tagger = fn;
}

/** Called from dispatchTransaction on every tr; no-op when dormant. */
export function tagCollabTransaction(tr: Transaction): void {
  tagger?.(tr);
}

/** Register a live session's binding plugins, keyed by the doc it owns. */
export function registerCollabPluginSource(src: CollabPluginSource): void {
  if (src.ownerUid == null) return; // unownable session can't be scoped
  pluginSources.set(src.ownerUid, src);
}

/** Drop the session owned by `ownerUid` (on end/leave). */
export function unregisterCollabPluginSource(ownerUid: string | null): void {
  if (ownerUid != null) pluginSources.delete(ownerUid);
}

/** The plugin source owned by `uid`, or null — for undo/redo routing and the
 *  per-view `ownsUndo` decision. */
export function collabPluginSourceFor(uid: string | null | undefined): CollabPluginSource | null {
  return uid != null ? pluginSources.get(uid) ?? null : null;
}

/** True if ANY session is live in this window (dormant-fast-path check). */
export function anyCollabSessionActive(): boolean {
  return pluginSources.size > 0;
}

/**
 * A session's binding plugins for the view identified by `targetUid`, or `[]`.
 * THE multi-pane fusion guard: a session's plugins attach ONLY to its own owning
 * doc's view. Every other pane — and the null/omitted uid — gets nothing, so
 * opening a second document while a session is live can never bind that pane to
 * a session's shared LoroDoc and overwrite it.
 */
export function collabPluginsFor(targetUid: string | null | undefined): Plugin[] {
  return collabPluginSourceFor(targetUid)?.plugins() ?? [];
}

/** Invite-join seam: the Receive pill (always-loaded pairing UI) hands a
 *  share code from a `room-invite` inbox item to the lazily-loaded collab
 *  module. Registered from editor/index.ts alongside the other collab
 *  ribbon wiring; null while the collab gate is closed. */
let inviteJoiner: ((shareCode: string) => void) | null = null;

export function setCollabInviteJoiner(fn: ((shareCode: string) => void) | null): void {
  inviteJoiner = fn;
}

export function collabInviteJoiner(): ((shareCode: string) => void) | null {
  return inviteJoiner;
}

/** A pairing recipient resolved by the Send pill (one partner, or a
 *  group fanned out to its members). */
export interface CollabInviteTarget {
  codes: string[];
  label: string;
  via?: string;
}

/** Invite-send seam: the Send pill's click mode hands a picked
 *  partner/group to the lazily-loaded collab module, which starts a
 *  session on the current doc if none is active and sends the invite
 *  (§6's picker-first flow). Null while the collab gate is closed. */
let inviter: ((target: CollabInviteTarget) => void) | null = null;

export function setCollabInviter(fn: ((target: CollabInviteTarget) => void) | null): void {
  inviter = fn;
}

export function collabInviter(): ((target: CollabInviteTarget) => void) | null {
  return inviter;
}

/** Live copresence for one open doc's session — connection status + who's here —
 *  read by the multi-pane shell to paint each slot's footer with ITS visible
 *  doc's session state. Provided by the lazily-loaded collab-ui once it's up;
 *  null before then (footers stay blank). Kept here (the zero-dependency seam)
 *  so the always-loaded shell never imports the heavy collab module. */
export interface CollabCopresence {
  connected: boolean;
  queued: number;
  peers: { name: string; color: string; self: boolean }[];
}

let copresenceProvider: ((uid: string) => CollabCopresence | null) | null = null;

export function setCollabCopresenceProvider(
  fn: ((uid: string) => CollabCopresence | null) | null,
): void {
  copresenceProvider = fn;
}

/** Copresence for the doc `uid`, or null when it has no live session (or collab
 *  isn't loaded). */
export function collabCopresenceFor(uid: string | null | undefined): CollabCopresence | null {
  return uid != null && copresenceProvider ? copresenceProvider(uid) : null;
}

const copresenceListeners = new Set<() => void>();

/** Subscribe to copresence changes (a session starting/ending, a status update,
 *  or a presence tick). Returns an unsubscribe. The shell repaints every slot
 *  footer on each fire. */
export function onCollabCopresenceChange(fn: () => void): () => void {
  copresenceListeners.add(fn);
  return () => {
    copresenceListeners.delete(fn);
  };
}

/** Fire the copresence listeners — called by collab-ui whenever a session's
 *  status/presence changes or a session starts/ends. No-op with no listeners. */
export function notifyCollabCopresenceChange(): void {
  for (const fn of copresenceListeners) fn();
}
