/**
 * Voice recognition worker — Electron utilityProcess entry point.
 * Recognition decode is synchronous FFI work; running it here means an
 * engine stall or crash can never block or take down the main process
 * (SPEC-voice.md §12 item 2 hardening). Speaks a tiny message protocol
 * with voice/ipc.ts over process.parentPort.
 */
import { VoiceService } from './service';

interface ParentPort {
  on(event: 'message', listener: (e: { data: WorkerInbound }) => void): void;
  postMessage(message: unknown): void;
}

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

const port = (process as unknown as { parentPort: ParentPort }).parentPort;

let service: VoiceService | null = null;

port.on('message', (e) => {
  const m = e.data;
  if (m.type === 'start') {
    try {
      service = new VoiceService({
        libPath: m.libPath,
        modelDir: m.modelDir,
        dictationModelDir: m.dictationModelDir,
        rmsGate: m.rmsGate,
        minWordConf: m.minWordConf,
        autoSleepSeconds: m.autoSleepSeconds,
        onEvent: (event) => port.postMessage({ type: 'event', event }),
        onLevel: (level) => port.postMessage({ type: 'level', level }),
      });
      const { modelLoadMs } = service.start();
      port.postMessage({ type: 'started', modelLoadMs });
    } catch (err) {
      port.postMessage({ type: 'error', error: String(err) });
    }
  } else if (m.type === 'audio') {
    service?.pushAudio(Buffer.from(m.chunk));
  } else if (m.type === 'vocab') {
    service?.setVocabulary(m.text);
  }
});
