/**
 * Voice IPC wiring (SPEC-voice.md §12 item 2). One recognition session
 * at a time, owned by the window that started it; that window receives
 * `voice:event` / `voice:level`. Audio flows renderer→main as raw PCM
 * over a fire-and-forget channel and is proxied to a **utilityProcess
 * worker** that owns the recognizer — decode is synchronous FFI work,
 * and isolating it means an engine stall or crash can never block or
 * kill the main process (a vosk grammar-swap abort and lgraph decode
 * bursts both did exactly that when the service ran in-process).
 */
import { app, ipcMain, utilityProcess } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { VoiceStartOptions, VoiceStartResult } from './types';

let worker: Electron.UtilityProcess | null = null;
let ownerWebContentsId: number | null = null;

function libFileName(): string {
  if (process.platform === 'win32') return 'libvosk.dll';
  if (process.platform === 'darwin') return 'libvosk.dylib';
  return 'libvosk.so';
}

/**
 * Locate libvosk + model. Search order:
 *  1. CARDMIRROR_VOICE_DIR (expects <dir>/<libvosk> and <dir>/model/)
 *  2. packaged resources (extraResources → resources/voice/)
 *  3. dev fallback: the recognizer spike's downloads in the repo
 */
function resolveVoiceAssets(): { libPath: string; modelDir: string } | null {
  const candidates: Array<{ libPath: string; modelDir: string }> = [];
  const envDir = process.env.CARDMIRROR_VOICE_DIR;
  if (envDir) {
    candidates.push({ libPath: path.join(envDir, libFileName()), modelDir: path.join(envDir, 'model') });
  }
  candidates.push({
    libPath: path.join(process.resourcesPath, 'voice', libFileName()),
    modelDir: path.join(process.resourcesPath, 'voice', 'model'),
  });
  if (!app.isPackaged) {
    const spike = path.join(__dirname, '..', '..', '..', '..', 'spikes', 'voice-recognizer');
    candidates.push({
      libPath: path.join(spike, 'lib', libFileName()),
      modelDir: path.join(spike, 'models', 'vosk-model-en-us-0.22-lgraph'),
    });
  }
  for (const c of candidates) {
    if (fs.existsSync(c.libPath) && fs.existsSync(c.modelDir)) return c;
  }
  return null;
}

function stopSession(): void {
  worker?.kill();
  worker = null;
  ownerWebContentsId = null;
}

const LARGE_MODEL_NAME = 'vosk-model-en-us-0.22';
const LARGE_MODEL_URL = `https://alphacephei.com/vosk/models/${LARGE_MODEL_NAME}.zip`;

function largeModelDir(): string {
  return path.join(app.getPath('userData'), 'voice-models', LARGE_MODEL_NAME);
}

function largeModelPresent(): boolean {
  return fs.existsSync(path.join(largeModelDir(), 'am'));
}

let downloadInFlight = false;

/** Download + extract the opt-in large dictation model (~1.8 GB) into
 *  userData, streaming progress to the requesting renderer. */
async function downloadLargeModel(sender: Electron.WebContents): Promise<{ ok: boolean; error?: string }> {
  if (largeModelPresent()) return { ok: true };
  if (downloadInFlight) return { ok: false, error: 'download-in-progress' };
  downloadInFlight = true;
  const root = path.join(app.getPath('userData'), 'voice-models');
  const zipPath = path.join(root, `${LARGE_MODEL_NAME}.zip`);
  try {
    fs.mkdirSync(root, { recursive: true });
    const res = await fetch(LARGE_MODEL_URL, { redirect: 'follow' });
    if (!res.ok || !res.body) return { ok: false, error: `HTTP ${res.status}` };
    const total = Number(res.headers.get('content-length')) || 0;
    const out = fs.createWriteStream(zipPath);
    const reader = res.body.getReader();
    let received = 0;
    let lastPct = -1;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      await new Promise<void>((resolve, reject) =>
        out.write(Buffer.from(value), (err) => (err ? reject(err) : resolve())),
      );
      const pct = total ? Math.floor((received / total) * 100) : 0;
      if (pct !== lastPct && !sender.isDestroyed()) {
        lastPct = pct;
        sender.send('voice:download-progress', { pct, receivedMB: Math.round(received / 1e6) });
      }
    }
    await new Promise<void>((resolve) => out.end(() => resolve()));
    if (!sender.isDestroyed()) sender.send('voice:download-progress', { pct: 100, extracting: true });
    const { execFileSync } = await import('node:child_process');
    try {
      execFileSync('unzip', ['-oq', zipPath, '-d', root]);
    } catch {
      execFileSync('tar', ['-xf', zipPath, '-C', root]);
    }
    fs.rmSync(zipPath, { force: true });
    return largeModelPresent() ? { ok: true } : { ok: false, error: 'extract-failed' };
  } catch (err) {
    fs.rmSync(zipPath, { force: true });
    return { ok: false, error: String(err) };
  } finally {
    downloadInFlight = false;
  }
}

export function registerVoiceIpc(): void {
  ipcMain.handle(
    'host:voice-start',
    async (event, opts: VoiceStartOptions = {}): Promise<VoiceStartResult> => {
      const sender = event.sender;
      if (worker && ownerWebContentsId !== sender.id) {
        return { ok: false, error: 'voice-in-use' };
      }
      if (worker) stopSession(); // same window restarting — rebuild cleanly
      const assets = opts.modelDir
        ? { libPath: resolveVoiceAssets()?.libPath ?? '', modelDir: opts.modelDir }
        : resolveVoiceAssets();
      if (!assets || !fs.existsSync(assets.libPath)) {
        return { ok: false, error: 'voice-assets-missing' };
      }

      const child = utilityProcess.fork(path.join(__dirname, 'worker.js'), [], {
        serviceName: 'cardmirror-voice',
        stdio: 'inherit', // recognizer diagnostics land in the main log
        env: { ...process.env },
      });
      worker = child;
      ownerWebContentsId = sender.id;

      const started = await new Promise<VoiceStartResult>((resolve) => {
        const timeout = setTimeout(() => resolve({ ok: false, error: 'voice-worker-timeout' }), 30000);
        child.once('message', (m: { type: string; modelLoadMs?: number; error?: string }) => {
          clearTimeout(timeout);
          if (m.type === 'started') resolve({ ok: true, modelLoadMs: m.modelLoadMs });
          else resolve({ ok: false, error: m.error ?? 'voice-worker-error' });
        });
        child.once('exit', () => {
          clearTimeout(timeout);
          resolve({ ok: false, error: 'voice-worker-died' });
        });
        child.postMessage({
          type: 'start',
          libPath: assets.libPath,
          modelDir: assets.modelDir,
          dictationModelDir:
            opts.dictationModel === 'large' && largeModelPresent() ? largeModelDir() : undefined,
          rmsGate: opts.rmsGate,
          minWordConf: opts.minWordConf,
          autoSleepSeconds: opts.autoSleepSeconds,
        });
      });
      if (!started.ok) {
        stopSession();
        return started;
      }
      if (opts.dictationModel === 'large' && !largeModelPresent()) {
        started.largeDictationMissing = true;
      }

      child.on('message', (m: { type: string; event?: unknown; level?: unknown }) => {
        if (sender.isDestroyed()) return;
        if (m.type === 'event') sender.send('voice:event', m.event);
        else if (m.type === 'level') sender.send('voice:level', m.level);
      });
      child.on('exit', (code) => {
        // Crash isolation: the editor survives; the session just ends.
        if (worker === child) {
          console.error(`voice: worker exited (code ${code})`);
          stopSession();
        }
      });
      sender.once('destroyed', () => {
        if (ownerWebContentsId === sender.id) stopSession();
      });
      return started;
    },
  );

  ipcMain.handle('host:voice-stop', async (event) => {
    if (ownerWebContentsId === event.sender.id) stopSession();
  });

  // Fire-and-forget PCM stream — `send`, not `invoke`: no per-chunk
  // round-trip, and a dropped chunk costs ms of audio, not state.
  ipcMain.on('host:voice-audio', (event, chunk: ArrayBuffer) => {
    if (ownerWebContentsId !== event.sender.id || !worker) return;
    worker.postMessage({ type: 'audio', chunk });
  });

  ipcMain.handle('host:voice-set-vocabulary', async (event, docText: string) => {
    if (ownerWebContentsId !== event.sender.id || !worker) return;
    worker.postMessage({ type: 'vocab', text: typeof docText === 'string' ? docText : '' });
  });

  ipcMain.handle('host:voice-dictation-model-info', async () => ({
    present: largeModelPresent(),
    downloading: downloadInFlight,
  }));

  ipcMain.handle('host:voice-download-dictation-model', async (event) =>
    downloadLargeModel(event.sender),
  );

  // Native clipboard ops for voice editing verbs — webContents.copy/
  // cut/paste are the same paths as Mod-C/X/V, so ProseMirror slice
  // semantics and structural paste rules are inherited (spec §5).
  ipcMain.handle('host:voice-clipboard', async (event, op: 'copy' | 'cut' | 'paste') => {
    if (op === 'copy') event.sender.copy();
    else if (op === 'cut') event.sender.cut();
    else if (op === 'paste') event.sender.paste();
  });
}

/** Test/diagnostic hook: is a session live, and for which webContents? */
export function voiceSessionInfo(): { active: boolean; ownerWebContentsId: number | null } {
  return { active: worker !== null, ownerWebContentsId };
}
