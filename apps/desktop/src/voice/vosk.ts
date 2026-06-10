/**
 * Minimal koffi bindings for libvosk (the official `vosk` npm package
 * is built on ffi-napi and does not load on modern Node/Electron).
 * Validated in spikes/voice-recognizer.
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const koffi = require('koffi');

interface VoskFns {
  setLogLevel: (level: number) => void;
  modelNew: (path: string) => unknown;
  modelFree: (model: unknown) => void;
  recNew: (model: unknown, sampleRate: number) => unknown;
  recNewGrm: (model: unknown, sampleRate: number, grammar: string) => unknown;
  recSetGrm: (rec: unknown, grammar: string) => void;
  recSetWords: (rec: unknown, words: number) => void;
  recAccept: (rec: unknown, data: Buffer, length: number) => number;
  recPartial: (rec: unknown) => string;
  recFinal: (rec: unknown) => string;
  recReset: (rec: unknown) => void;
  recFree: (rec: unknown) => void;
}

let fns: VoskFns | null = null;

export function loadLibVosk(libPath: string): void {
  if (fns) return;
  const lib = koffi.load(libPath);
  fns = {
    setLogLevel: lib.func('void vosk_set_log_level(int level)'),
    modelNew: lib.func('void *vosk_model_new(const char *path)'),
    modelFree: lib.func('void vosk_model_free(void *model)'),
    recNew: lib.func('void *vosk_recognizer_new(void *model, float sample_rate)'),
    recNewGrm: lib.func('void *vosk_recognizer_new_grm(void *model, float sample_rate, const char *grammar)'),
    recSetGrm: lib.func('void vosk_recognizer_set_grm(void *rec, const char *grammar)'),
    recSetWords: lib.func('void vosk_recognizer_set_words(void *rec, int words)'),
    recAccept: lib.func('int vosk_recognizer_accept_waveform(void *rec, const uint8_t *data, int length)'),
    recPartial: lib.func('const char *vosk_recognizer_partial_result(void *rec)'),
    recFinal: lib.func('const char *vosk_recognizer_final_result(void *rec)'),
    recReset: lib.func('void vosk_recognizer_reset(void *rec)'),
    recFree: lib.func('void vosk_recognizer_free(void *rec)'),
  };
  fns.setLogLevel(-1);
}

function api(): VoskFns {
  if (!fns) throw new Error('voice: loadLibVosk() must be called before using vosk');
  return fns;
}

export interface WordResult {
  word: string;
  start: number;
  end: number;
  conf?: number;
}

export interface FinalResult {
  text: string;
  words: WordResult[] | null;
}

export class Model {
  private ptr: unknown;

  constructor(modelPath: string) {
    this.ptr = api().modelNew(modelPath);
    if (!this.ptr) throw new Error(`voice: failed to load vosk model at ${modelPath}`);
  }

  get handle(): unknown {
    return this.ptr;
  }

  free(): void {
    if (this.ptr) api().modelFree(this.ptr);
    this.ptr = null;
  }
}

export class Recognizer {
  private ptr: unknown;

  constructor(model: Model, sampleRate: number, grammar?: string[]) {
    this.ptr = grammar
      ? api().recNewGrm(model.handle, sampleRate, JSON.stringify(grammar))
      : api().recNew(model.handle, sampleRate);
    if (!this.ptr) throw new Error('voice: failed to create recognizer');
  }

  setGrammar(phrases: string[]): void {
    api().recSetGrm(this.ptr, JSON.stringify(phrases));
  }

  setWords(on: boolean): void {
    api().recSetWords(this.ptr, on ? 1 : 0);
  }

  accept(pcm: Buffer): boolean {
    return api().recAccept(this.ptr, pcm, pcm.length) === 1;
  }

  partial(): string {
    const parsed = JSON.parse(api().recPartial(this.ptr)) as { partial?: string };
    return parsed.partial ?? '';
  }

  final(): FinalResult {
    const parsed = JSON.parse(api().recFinal(this.ptr)) as {
      text?: string;
      result?: WordResult[];
    };
    return { text: parsed.text ?? '', words: parsed.result ?? null };
  }

  reset(): void {
    api().recReset(this.ptr);
  }

  free(): void {
    if (this.ptr) api().recFree(this.ptr);
    this.ptr = null;
  }
}
