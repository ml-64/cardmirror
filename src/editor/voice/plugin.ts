/**
 * Voice plugin state + utterance-atomicity machinery (SPEC-voice.md §8,
 * §12 item 3). The single most important contract here: one utterance =
 * one undo step, exactly, so `scratch that` ≡ Ctrl+Z. Mechanism:
 *
 *  - every transaction produced by a voice utterance carries the
 *    utterance id in meta;
 *  - the FIRST transaction of a new utterance closes the previous
 *    history group (`closeHistory`), so the utterance starts fresh;
 *  - when the utterance finishes, `sealUtterance` closes the group
 *    again, so subsequent keyboard input can never merge into it.
 *
 * Within the utterance, prosemirror-history's normal adjacent-step
 * merging does the grouping — no custom history plugin.
 */
import { Plugin, PluginKey } from 'prosemirror-state';
import type { EditorState, Transaction } from 'prosemirror-state';
import { Decoration, DecorationSet } from 'prosemirror-view';
import { closeHistory } from 'prosemirror-history';
import { VOICE_NEAR_RADIUS } from './align.js';
import type { PenName, VoiceMode } from './types';

export interface VoiceLogEntry {
  utteranceId: number;
  kind: 'command' | 'rejection' | 'dictation' | 'mode';
  text: string;
}

export interface VoicePluginState {
  listening: boolean;
  mode: VoiceMode;
  pen: { name: PenName; color?: string };
  /** Last utterance id whose transactions reached this state. */
  lastUtteranceId: number;
  /** Resolved range of the last span operation, position-mapped through
   *  every subsequent transaction (`again but`, §8). */
  lastOpRange: { from: number; to: number } | null;
  /** Recent tray scrollback (newest last, capped). */
  log: VoiceLogEntry[];
  /** Streaming dictation transcript, rendered as a ghost-text widget
   *  at the cursor (decoration only — never document content). */
  ghostText: string | null;
  /** Jump history for `go back`: origins of cursor jumps (≥ JUMP_MIN
   *  positions), newest last, positions remapped through edits. */
  backStack: number[];
  /** Last repeat-eligible command, for bare `again`. */
  lastRepeatable: { verb: string; args: Record<string, unknown>; raw: string } | null;
  /** Reactive quote disambiguation (§4.1): candidate ranges shown as
   *  numbered in-document badges; `pick <n>` completes the stored
   *  operation, anything else dismisses. */
  pendingDisambiguation: {
    candidates: Array<{ from: number; to: number }>;
    verb: string;
    args: Record<string, unknown>;
    raw: string;
  } | null;
  /** Live paint session (§6): anchor for alignment, provisional ink
   *  spans (decorations, never marks), and the reading head. */
  paintSession: {
    anchor: number;
    provisional: Array<{ from: number; to: number }>;
    headPos: number;
  } | null;
}

/** A selection move this large (or larger) counts as a jump. */
const JUMP_MIN = 50;
const BACK_STACK_CAP = 20;

const LOG_CAP = 50;

/** Transaction meta key carrying { utteranceId }. */
export const VOICE_UTTERANCE_META = 'voiceUtterance';

export const voicePluginKey = new PluginKey<VoicePluginState>('cardmirrorVoice');

const INITIAL: VoicePluginState = {
  listening: false,
  mode: 'command',
  pen: { name: 'underline' }, // boot pen is always underline (§3)
  lastUtteranceId: 0,
  lastOpRange: null,
  log: [],
  ghostText: null,
  backStack: [],
  lastRepeatable: null,
  pendingDisambiguation: null,
  paintSession: null,
};

/** Patch applied via tr.setMeta(voicePluginKey, patch). */
export interface VoiceStatePatch {
  listening?: boolean;
  mode?: VoiceMode;
  pen?: { name: PenName; color?: string };
  lastOpRange?: { from: number; to: number } | null;
  appendLog?: VoiceLogEntry;
  ghostText?: string | null;
  /** Pop the jump stack (a `go back` jump is consuming, and its own
   *  move must not be re-recorded — pair with suppressJumpRecord). */
  popBack?: boolean;
  suppressJumpRecord?: boolean;
  lastRepeatable?: { verb: string; args: Record<string, unknown>; raw: string } | null;
  pendingDisambiguation?: VoicePluginState['pendingDisambiguation'];
  paintSession?: VoicePluginState['paintSession'];
}

export function voicePlugin(): Plugin<VoicePluginState> {
  return new Plugin<VoicePluginState>({
    key: voicePluginKey,
    state: {
      init: () => ({ ...INITIAL }),
      apply(
        tr: Transaction,
        prev: VoicePluginState,
        oldState: EditorState,
        newState: EditorState,
      ): VoicePluginState {
        let next = prev;
        if (tr.docChanged && prev.lastOpRange) {
          next = {
            ...next,
            lastOpRange: {
              from: tr.mapping.map(prev.lastOpRange.from),
              to: tr.mapping.map(prev.lastOpRange.to),
            },
          };
        }
        if (tr.docChanged && next.backStack.length) {
          next = { ...next, backStack: next.backStack.map((p) => tr.mapping.map(p)) };
        }
        if (tr.docChanged && next.paintSession) {
          next = {
            ...next,
            paintSession: {
              anchor: tr.mapping.map(next.paintSession.anchor),
              headPos: tr.mapping.map(next.paintSession.headPos),
              provisional: next.paintSession.provisional.map((s) => ({
                from: tr.mapping.map(s.from),
                to: tr.mapping.map(s.to),
              })),
            },
          };
        }
        if (tr.docChanged && next.pendingDisambiguation) {
          next = {
            ...next,
            pendingDisambiguation: {
              ...next.pendingDisambiguation,
              candidates: next.pendingDisambiguation.candidates.map((c) => ({
                from: tr.mapping.map(c.from),
                to: tr.mapping.map(c.to),
              })),
            },
          };
        }
        const earlyPatch = tr.getMeta(voicePluginKey) as VoiceStatePatch | undefined;
        if (tr.selectionSet && !earlyPatch?.suppressJumpRecord) {
          const origin = tr.mapping.map(oldState.selection.head);
          if (Math.abs(newState.selection.head - origin) >= JUMP_MIN) {
            next = {
              ...next,
              backStack: [...next.backStack, origin].slice(-BACK_STACK_CAP),
            };
          }
        }
        const utter = tr.getMeta(VOICE_UTTERANCE_META) as { utteranceId: number } | undefined;
        if (utter && utter.utteranceId !== next.lastUtteranceId) {
          next = { ...next, lastUtteranceId: utter.utteranceId };
        }
        const patch = tr.getMeta(voicePluginKey) as VoiceStatePatch | undefined;
        if (patch) {
          next = { ...next };
          if (patch.listening !== undefined) next.listening = patch.listening;
          if (patch.mode !== undefined) next.mode = patch.mode;
          if (patch.pen !== undefined) next.pen = patch.pen;
          if (patch.lastOpRange !== undefined) next.lastOpRange = patch.lastOpRange;
          if (patch.appendLog) next.log = [...next.log, patch.appendLog].slice(-LOG_CAP);
          if (patch.ghostText !== undefined) next.ghostText = patch.ghostText;
          if (patch.popBack) next.backStack = next.backStack.slice(0, -1);
          if (patch.lastRepeatable !== undefined) next.lastRepeatable = patch.lastRepeatable;
          if (patch.pendingDisambiguation !== undefined) {
            next.pendingDisambiguation = patch.pendingDisambiguation;
          }
          if (patch.paintSession !== undefined) next.paintSession = patch.paintSession;
        }
        return next;
      },
    },
    props: {
      decorations(state: EditorState) {
        const st = voicePluginKey.getState(state);
        if (!st) return null;
        const decos: Decoration[] = [];
        // Speak-to-target reach (§4.1 visibility): faint tint over the
        // near-cursor span the decode vocabulary is built from — the
        // text you can currently quote, and where matching is loosest.
        if (st.listening && (st.mode === 'command' || st.mode === 'paint')) {
          const head = state.selection.head;
          const from = Math.max(0, head - VOICE_NEAR_RADIUS);
          const to = Math.min(state.doc.content.size, head + VOICE_NEAR_RADIUS);
          if (to > from) {
            decos.push(Decoration.inline(from, to, { class: 'pmd-voice-reach' }));
          }
        }
        if (st.ghostText) {
          const ghost = st.ghostText;
          decos.push(
            Decoration.widget(
              state.selection.head,
              () => {
                const span = document.createElement('span');
                span.className = 'pmd-voice-ghost';
                span.textContent = ghost;
                return span;
              },
              { side: 1, key: `voice-ghost-${ghost}` },
            ),
          );
        }
        if (st.paintSession) {
          for (const s of st.paintSession.provisional) {
            if (s.to > s.from) {
              decos.push(
                Decoration.inline(s.from, s.to, { class: 'pmd-voice-paint-provisional' }),
              );
            }
          }
          decos.push(
            Decoration.widget(
              st.paintSession.headPos,
              () => {
                const head = document.createElement('span');
                head.className = 'pmd-voice-paint-head';
                return head;
              },
              { side: 1, key: `voice-paint-head-${st.paintSession.headPos}` },
            ),
          );
        }
        if (st.pendingDisambiguation) {
          st.pendingDisambiguation.candidates.forEach((c, i) => {
            decos.push(
              Decoration.inline(c.from, c.to, { class: 'pmd-voice-candidate' }),
            );
            decos.push(
              Decoration.widget(
                c.from,
                () => {
                  const chip = document.createElement('span');
                  chip.className = 'pmd-voice-candidate-badge';
                  chip.textContent = String(i + 1);
                  return chip;
                },
                { side: -1, key: `voice-cand-${i}-${c.from}` },
              ),
            );
          });
        }
        return decos.length ? DecorationSet.create(state.doc, decos) : null;
      },
    },
  });
}

/** Minimal view surface the dispatcher needs — also what tests provide. */
export interface ViewLike {
  readonly state: EditorState;
  dispatch(tr: Transaction): void;
}

/**
 * Returns a dispatch function for one utterance: the first transaction
 * of a new utterance id seals the previous undo group, and every
 * transaction is tagged with the utterance id.
 */
export function voiceDispatcher(view: ViewLike, utteranceId: number): (tr: Transaction) => void {
  let first = true;
  return (tr: Transaction) => {
    const st = voicePluginKey.getState(view.state);
    if (first && st && st.lastUtteranceId !== utteranceId) tr = closeHistory(tr);
    tr.setMeta(VOICE_UTTERANCE_META, { utteranceId });
    first = false;
    view.dispatch(tr);
  };
}

/**
 * Seal the undo group after an utterance's transactions have all been
 * dispatched: a steps-less transaction carrying closeHistory, so the
 * next keyboard input starts its own group instead of merging into the
 * utterance (prosemirror-history would otherwise merge anything within
 * its newGroupDelay window).
 */
export function sealUtterance(view: ViewLike): void {
  view.dispatch(closeHistory(view.state.tr));
}

/** Apply a state patch outside any utterance (pen change, log echo …). */
export function patchVoiceState(view: ViewLike, patch: VoiceStatePatch): void {
  const tr = view.state.tr;
  tr.setMeta(voicePluginKey, patch);
  tr.setMeta('addToHistory', false);
  view.dispatch(tr);
}
