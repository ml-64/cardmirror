/**
 * Microphone capture (renderer side): getUserMedia → 16 kHz mono s16le
 * PCM chunks pushed to the main-process recognizer. The renderer never
 * processes the audio beyond format conversion; recognition lives in
 * main (SPEC-voice.md §10).
 */

export class MicCapture {
  private stream: MediaStream | null = null;
  private ctx: AudioContext | null = null;
  private node: ScriptProcessorNode | null = null;

  get running(): boolean {
    return this.stream !== null;
  }

  async start(onChunk: (pcm: ArrayBuffer) => void, deviceId?: string): Promise<void> {
    if (this.stream) return;
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    // Chromium resamples to the context rate — ask for 16 kHz directly.
    this.ctx = new AudioContext({ sampleRate: 16000 });
    const source = this.ctx.createMediaStreamSource(this.stream);
    // ScriptProcessor is deprecated but dependency-free and fine for a
    // 16 kHz mono tap; an AudioWorklet swap is mechanical if it goes.
    this.node = this.ctx.createScriptProcessor(4096, 1, 1);
    this.node.onaudioprocess = (e) => {
      const f32 = e.inputBuffer.getChannelData(0);
      const i16 = new Int16Array(f32.length);
      for (let i = 0; i < f32.length; i++) {
        const s = Math.max(-1, Math.min(1, f32[i] as number));
        i16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
      onChunk(i16.buffer);
    };
    source.connect(this.node);
    this.node.connect(this.ctx.destination); // required for processing to run
  }

  stop(): void {
    this.node?.disconnect();
    this.node = null;
    void this.ctx?.close();
    this.ctx = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
  }
}
