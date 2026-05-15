/**
 * Speech-doc registry.
 *
 * Tracks which open EditorView is currently designated as the
 * "speech doc" — the destination for `sendToSpeech` (\` / Alt-\`).
 * Verbatim's equivalent is a single global `ActiveSpeechDoc` string
 * (filename). We use a live view reference instead because there's
 * no filename round-trip pressure here (the designation is
 * session-only) and because resolving by reference avoids any
 * filename-collision pitfalls.
 *
 * The registry lives in its own module rather than directly in
 * `editor/index.ts` or `multi-pane-shell.ts` because more than one
 * "host" needs to plug into it: the multi-pane shell registers /
 * unregisters as docs land in its slots, and a future cross-window
 * single-doc broker will do the same for windows in its own
 * window-spanning state.
 *
 * The `SpeechDocResolver` interface is intentionally minimal — only
 * the bits other modules read. Hosts that need richer integration
 * (e.g., the multi-pane shell wanting to find which Slot holds the
 * speech doc) keep that lookup in their own structures and call
 * `setSpeech(view)` to publish.
 */

import type { EditorView } from 'prosemirror-view';

export interface SpeechDocResolver {
  /** The view currently designated as the speech doc, or null when
   *  no doc has been marked. */
  getSpeechView(): EditorView | null;
  /** Designate the given view as the speech doc, clearing any
   *  previous designation. Passing `null` clears the registry. */
  setSpeech(view: EditorView | null): void;
  /** Subscribe to changes. The callback fires whenever the speech
   *  view changes (designation set, cleared, or swapped). Returns
   *  an unsubscribe function. */
  subscribe(fn: () => void): () => void;
}

class DefaultSpeechDocResolver implements SpeechDocResolver {
  private speechView: EditorView | null = null;
  private listeners = new Set<() => void>();

  getSpeechView(): EditorView | null {
    return this.speechView;
  }

  setSpeech(view: EditorView | null): void {
    if (this.speechView === view) return;
    this.speechView = view;
    for (const fn of this.listeners) {
      try { fn(); } catch (err) { console.error('speech-doc listener error', err); }
    }
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

/** Module singleton. Multi-pane mounts this directly; a future
 *  multi-window broker can replace it via `setSpeechDocResolver`
 *  to coordinate state across windows. */
let resolver: SpeechDocResolver = new DefaultSpeechDocResolver();

export function getSpeechDocResolver(): SpeechDocResolver {
  return resolver;
}

/** Swap in a custom resolver (e.g., a multi-window broker). Hosts
 *  that call this are responsible for forwarding any prior
 *  designation forward. */
export function setSpeechDocResolver(next: SpeechDocResolver): void {
  resolver = next;
}
