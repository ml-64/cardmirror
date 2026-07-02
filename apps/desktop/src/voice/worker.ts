/**
 * Voice recognition worker — runs as a PLAIN NODE child process
 * (child_process.fork with ELECTRON_RUN_AS_NODE), not an Electron
 * utilityProcess: utilityProcess SIGTRAPs loading the multi-GB large
 * dictation model (plain Node loads it fine).
 * Isolation properties are identical — decode is synchronous FFI work,
 * and an engine stall or crash can never block or take down the main
 * process (SPEC-voice.md §12 item 2 hardening). Speaks a tiny message
 * protocol with voice/ipc.ts over the fork IPC channel (advanced
 * serialization, so ArrayBuffer audio chunks structured-clone through).
 */
import { VoiceService } from './service';

type WorkerInbound =
  | {
      type: 'start';
      libPath: string;
      modelDir: string;
      dictationModelDir?: string;
      rmsGate?: number;
      minWordConf?: number;
      autoSleepSeconds?: number;
    }
  | { type: 'audio'; chunk: ArrayBuffer }
  | { type: 'vocab'; text: string };

const send = (m: unknown): void => {
  process.send?.(m);
};

let service: VoiceService | null = null;

process.on('message', (m: WorkerInbound) => {
  if (m.type === 'start') {
    try {
      service = new VoiceService({
        libPath: m.libPath,
        modelDir: m.modelDir,
        dictationModelDir: m.dictationModelDir,
        rmsGate: m.rmsGate,
        minWordConf: m.minWordConf,
        autoSleepSeconds: m.autoSleepSeconds,
        onEvent: (event) => send({ type: 'event', event }),
        onLevel: (level) => send({ type: 'level', level }),
      });
      const { modelLoadMs } = service.start();
      send({ type: 'started', modelLoadMs });
    } catch (err) {
      send({ type: 'error', error: String(err) });
    }
  } else if (m.type === 'audio') {
    // Validate — a malformed payload must not kill the worker (the
    // renderer then dictates into a dead session). Advanced
    // serialization delivers ArrayBuffer; tolerate Buffer views too.
    if (m.chunk instanceof ArrayBuffer) service?.pushAudio(Buffer.from(m.chunk));
    else if (ArrayBuffer.isView(m.chunk)) service?.pushAudio(Buffer.from((m.chunk as Uint8Array).buffer));
  } else if (m.type === 'vocab') {
    if (typeof m.text === 'string') service?.setVocabulary(m.text);
  }
});
