/**
 * Renderer-side mirror of the main process's typed voice events
 * (SPEC-voice.md §10, §12 item 2 — apps/desktop/src/voice/types.ts).
 * The renderer voice layer consumes these and nothing lower-level:
 * no raw audio, no transcription streams.
 */

export type VoiceMode = 'command' | 'dictation' | 'paint' | 'asleep';

export type PenName = 'underline' | 'highlight' | 'emphasis' | 'cite';

export interface CommandArgs {
  pen?: string;
  color?: string;
  n?: number;
  dir?: 'left' | 'right' | 'up' | 'down';
  unit?: 'words' | 'lines';
  target?: string;
  quote?: string;
}

export interface VoiceEventBase {
  utteranceId: number;
  mode: VoiceMode;
  raw: string;
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
     *  open — rendered as provisional ghost text, never as document
     *  content. Empty text clears the ghost. */
    | { kind: 'dictation-partial'; text: string }
    /** Streaming in-progress transcript while a PAINT utterance is open
     *  — drives provisional ink (§6). Empty text clears. */
    | { kind: 'paint-partial'; text: string }
    | { kind: 'mode'; from: VoiceMode; to: VoiceMode; trigger: string }
  );

export interface VoiceLevel {
  rms: number;
  gate: number;
  calibrating: boolean;
  /** Present only in the final 10 s before idle auto-sleep. */
  autoSleepRemainingMs?: number;
}
