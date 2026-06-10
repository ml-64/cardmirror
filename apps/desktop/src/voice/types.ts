/**
 * Typed parse-event contract between the main-process recognition
 * service and the renderer voice layer (SPEC-voice.md §10, §12 item 2).
 * The renderer never sees raw audio or raw transcription streams —
 * only these events — which keeps the renderer plugin testable with
 * synthetic event streams.
 */

export type VoiceMode = 'command' | 'dictation' | 'paint' | 'asleep';

/** Arguments extracted from a parsed command utterance. */
export interface CommandArgs {
  /** Pen name for pen/again-but commands. */
  pen?: string;
  /** Highlight color when specified. */
  color?: string;
  /** Count for cursor-relative moves and `card <n>` / `pick <n>`. */
  n?: number;
  /** Direction for cursor-relative moves. */
  dir?: 'left' | 'right' | 'up' | 'down';
  /** Unit for cursor-relative moves. */
  unit?: 'words' | 'lines';
  /** Structural target (card, tag, cite, body, analytic, unit, …). */
  target?: string;
  /** Spoken-text quote tail, when the verb takes one. */
  quote?: string;
}

export interface VoiceEventBase {
  /** Monotonic per-session utterance id — also the undo-grouping key. */
  utteranceId: number;
  mode: VoiceMode;
  /** What the recognizer heard, for tray echo ("what did it think I said?"). */
  raw: string;
  /** ms timestamps (performance.now() epoch of the main process). */
  tEndOfSpeech: number;
  tParse: number;
}

export type VoiceEvent = VoiceEventBase &
  (
    | { kind: 'command'; verb: string; args: CommandArgs }
    | {
        kind: 'rejection';
        reason: 'out-of-grammar' | 'low-confidence' | 'invalid-utterance';
      }
    | { kind: 'dictation'; text: string }
    /** Streaming in-progress transcript while a dictation utterance is
     *  open — render as provisional ghost text, never as document
     *  content. An empty text clears the ghost. */
    | { kind: 'dictation-partial'; text: string }
    /** Streaming in-progress transcript while a PAINT utterance is open
     *  — drives provisional ink (§6). Empty text clears. */
    | { kind: 'paint-partial'; text: string }
    | { kind: 'mode'; from: VoiceMode; to: VoiceMode; trigger: string }
  );

/** Throttled input-level report for the tray meter (§10 audio-input affordance). */
export interface VoiceLevelEvent {
  rms: number;
  gate: number;
  calibrating: boolean;
  /** Present only in the final 10 s before idle auto-sleep (§2.1) —
   *  drives the pill's countdown dimming. */
  autoSleepRemainingMs?: number;
}

export interface VoiceStartOptions {
  /** Directory containing the vosk model (defaults resolved by the host). */
  modelDir?: string;
  /** Override the voice-activity gate; omit for ambient auto-calibration. */
  rmsGate?: number;
  /** Per-word confidence threshold for grammar parses (default 0.7). */
  minWordConf?: number;
  /** Idle seconds before auto-sleep (§2.1). 0 disables; default 60. */
  autoSleepSeconds?: number;
  /** Which model decodes open dictation: the shipped standard model or
   *  the opt-in large download. */
  dictationModel?: 'standard' | 'large';
}

export interface VoiceStartResult {
  ok: boolean;
  error?: string;
  modelLoadMs?: number;
  /** Large dictation was requested but isn't downloaded — session runs
   *  on the standard model. */
  largeDictationMissing?: boolean;
}
