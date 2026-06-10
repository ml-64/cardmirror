// Minimal koffi bindings for libvosk — the same FFI path Electron main would use.
import koffi from 'koffi'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const lib = koffi.load(path.join(here, '..', 'lib', 'libvosk.so'))

const fns = {
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
}

export function setLogLevel(level) {
  fns.setLogLevel(level)
}

export class Model {
  constructor(modelPath) {
    this.ptr = fns.modelNew(modelPath)
    if (!this.ptr) throw new Error(`failed to load model at ${modelPath}`)
  }
  free() {
    fns.modelFree(this.ptr)
    this.ptr = null
  }
}

export class Recognizer {
  constructor(model, sampleRate, grammar = null) {
    this.ptr = grammar
      ? fns.recNewGrm(model.ptr, sampleRate, JSON.stringify(grammar))
      : fns.recNew(model.ptr, sampleRate)
    if (!this.ptr) throw new Error('failed to create recognizer')
  }
  setGrammar(phrases) {
    fns.recSetGrm(this.ptr, JSON.stringify(phrases))
  }
  setWords(on) {
    fns.recSetWords(this.ptr, on ? 1 : 0)
  }
  /** Returns true when vosk's own endpointer fired. */
  accept(buf) {
    return fns.recAccept(this.ptr, buf, buf.length) === 1
  }
  partial() {
    return JSON.parse(fns.recPartial(this.ptr))
  }
  final() {
    return JSON.parse(fns.recFinal(this.ptr))
  }
  reset() {
    fns.recReset(this.ptr)
  }
  free() {
    fns.recFree(this.ptr)
    this.ptr = null
  }
}
