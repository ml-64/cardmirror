/**
 * Mic capture resampling — the renderer captures at the device's native
 * rate and downsamples to 16 kHz for the recognizer (forcing a 16 kHz
 * AudioContext produced silence on macOS Core Audio).
 */

import { describe, expect, it } from 'vitest';
import { downsampleTo16k } from '../../src/editor/voice/capture.js';

describe('downsampleTo16k', () => {
  it('returns the input unchanged when already 16 kHz', () => {
    const input = new Float32Array([0.1, -0.2, 0.3, -0.4]);
    expect(downsampleTo16k(input, 16000)).toBe(input);
  });

  it('halves the length from 32 kHz', () => {
    const input = new Float32Array(3200); // 0.1s at 32k
    expect(downsampleTo16k(input, 32000).length).toBe(1600); // 0.1s at 16k
  });

  it('thirds the length from 48 kHz', () => {
    const input = new Float32Array(4800); // 0.1s at 48k
    expect(downsampleTo16k(input, 48000).length).toBe(1600);
  });

  it('handles the non-integer 44.1 kHz ratio without overrunning', () => {
    const input = new Float32Array(4410); // 0.1s at 44.1k
    const out = downsampleTo16k(input, 44100);
    expect(out.length).toBe(1600);
    expect(out.every((v) => Number.isFinite(v))).toBe(true);
  });

  it('box-averages so a constant signal is preserved', () => {
    const input = new Float32Array(4800).fill(0.5);
    const out = downsampleTo16k(input, 48000);
    for (const v of out) expect(v).toBeCloseTo(0.5, 5);
  });

  it('preserves DC level of a 2x downsample (average of pairs)', () => {
    // [1,1,0,0,1,1,0,0,...] at 32k → averages of pairs → [1,0,1,0,...] at 16k.
    const input = new Float32Array(3200);
    for (let i = 0; i < input.length; i++) input[i] = (Math.floor(i / 2) % 2) === 0 ? 1 : 0;
    const out = downsampleTo16k(input, 32000);
    expect(out[0]).toBeCloseTo(1, 5);
    expect(out[1]).toBeCloseTo(0, 5);
    expect(out[2]).toBeCloseTo(1, 5);
  });

  it('empty input yields empty output', () => {
    expect(downsampleTo16k(new Float32Array(0), 48000).length).toBe(0);
  });
});
