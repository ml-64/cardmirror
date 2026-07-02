/**
 * Voice-activity gating + utterance segmentation (SPEC-voice.md §2).
 * The gate auto-calibrates against ambient noise — both spike failure
 * modes are handled: a fixed gate below the noise floor (hears
 * everything, reports nothing) and a capture-start transient pegging
 * the calibration (gate becomes uncrossable).
 */

export const PAUSE_MS = 350;

const CALIB_SKIP_MS = 500; // capture-start transient window to discard
const CALIB_MEASURE_MS = 1800;
const CALIB_FALLBACK_MS = 4000;
const CLIPPED_RMS = 30000;
const FALLBACK_GATE = 2000;
const GATE_FLOOR_MULTIPLIER = 2.5;
const MIN_GATE = 300;

export function rmsOf(samples: Int16Array): number {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i] as number;
    sum += s * s;
  }
  return samples.length ? Math.sqrt(sum / samples.length) : 0;
}

export type SegmenterResult =
  | { type: 'calibrating' }
  | { type: 'calibrated'; gate: number; noiseFloor: number | null }
  | { type: 'speech'; rms: number }
  | { type: 'silence'; rms: number }
  /** Voiced burst too short to be speech (breath, click): callers should
   *  reset recognizers so the noise can't bleed into the next decode,
   *  but no utterance happened. */
  | { type: 'blip'; rms: number }
  | { type: 'utterance-end'; tLastVoiced: number; voicedMs: number; rms: number };

/** Voiced bursts shorter than this never become utterances. The
 *  shortest real command ("mark") is ~250 ms of voicing. */
const MIN_VOICED_MS = 150;

export class Segmenter {
  private gate: number;
  private calibMs = 0;
  private calibVals: number[] = [];
  private voicedSeen = false;
  private silentMs = 0;
  private tLastVoiced = 0;
  /** Utterance extent measured on the AUDIO clock (sum of chunk
   *  durations), not wall time — correct under faster-than-real-time
   *  feeding (tests) and chunk-delivery jitter. */
  private audioMs = 0;
  private firstVoicedAudioMs = 0;
  private lastVoicedAudioMs = 0;
  private pauseMs: number;
  /** Rolling recent RMS values for jam recalibration. */
  private recentRms: number[] = [];

  /** True while an utterance is open (speech seen, pause not reached).
   *  Exposed so the service can tell "recognizer consumed only silence"
   *  from "recognizer is mid-utterance" (vocabulary hot-swap safety). */
  get voicedActive(): boolean {
    return this.voicedSeen;
  }

  constructor(opts: { rmsGate?: number; pauseMs?: number } = {}) {
    this.gate = opts.rmsGate ?? 0; // 0 = auto-calibrate
    this.pauseMs = opts.pauseMs ?? PAUSE_MS;
  }

  get currentGate(): number {
    return this.gate;
  }

  get isCalibrating(): boolean {
    return this.gate === 0;
  }

  /** Feed one PCM chunk; returns what happened. `now` is a ms timestamp. */
  push(samples: Int16Array, sampleRate: number, now: number): SegmenterResult {
    const chunkMs = (samples.length / sampleRate) * 1000;
    this.audioMs += chunkMs;
    const rms = rmsOf(samples);

    if (this.gate === 0) {
      this.calibMs += chunkMs;
      if (this.calibMs > CALIB_SKIP_MS && rms < CLIPPED_RMS) this.calibVals.push(rms);
      if (this.calibMs >= CALIB_MEASURE_MS && this.calibVals.length >= 5) {
        const sorted = [...this.calibVals].sort((a, b) => a - b);
        const floor = sorted[Math.floor(sorted.length / 2)] as number;
        this.gate = Math.max(MIN_GATE, Math.round(floor * GATE_FLOOR_MULTIPLIER));
        return { type: 'calibrated', gate: this.gate, noiseFloor: floor };
      }
      if (this.calibMs >= CALIB_FALLBACK_MS) {
        this.gate = FALLBACK_GATE;
        return { type: 'calibrated', gate: this.gate, noiseFloor: null };
      }
      return { type: 'calibrating' };
    }

    this.recentRms.push(rms);
    if (this.recentRms.length > 100) this.recentRms.shift();

    if (rms > this.gate) {
      if (!this.voicedSeen) this.firstVoicedAudioMs = this.audioMs;
      this.voicedSeen = true;
      this.silentMs = 0;
      this.tLastVoiced = now;
      this.lastVoicedAudioMs = this.audioMs;
      // Jam detection: a mid-session noise-floor rise (AC, fans) keeps
      // every chunk above the gate — no pause is ever seen, so no
      // utterance can complete and the session is stuck until restart.
      // Twenty seconds of unbroken "speech" is not speech; recalibrate
      // the gate from recent levels.
      if (this.audioMs - this.firstVoicedAudioMs > 20_000) {
        const sorted = [...this.recentRms].sort((a, b) => a - b);
        const median = sorted[Math.floor(sorted.length / 2)] as number;
        this.gate = Math.max(MIN_GATE, Math.round(median * GATE_FLOOR_MULTIPLIER));
        this.voicedSeen = false;
        this.silentMs = 0;
        return { type: 'calibrated', gate: this.gate, noiseFloor: median };
      }
      return { type: 'speech', rms };
    }
    if (this.voicedSeen) {
      this.silentMs += chunkMs;
      if (this.silentMs >= this.pauseMs) {
        this.voicedSeen = false;
        this.silentMs = 0;
        const voicedMs = this.lastVoicedAudioMs - this.firstVoicedAudioMs;
        if (voicedMs < MIN_VOICED_MS) return { type: 'blip', rms };
        return { type: 'utterance-end', tLastVoiced: this.tLastVoiced, voicedMs, rms };
      }
    }
    return { type: 'silence', rms };
  }

  /** Update the pause threshold (dictation may use a longer one, §7). */
  setPauseMs(ms: number): void {
    this.pauseMs = ms;
  }
}
