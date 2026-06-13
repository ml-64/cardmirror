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
import { app, ipcMain, systemPreferences } from 'electron';
import { fork, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { VoiceStartOptions, VoiceStartResult } from './types';

let worker: ChildProcess | null = null;
let ownerWebContentsId: number | null = null;
/** Owner-lifecycle listeners, removed in stopSession so repeated
 *  starts don't stack handlers (audit 2026-06-10). */
let ownerCleanup: (() => void) | null = null;

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

/**
 * The worker needs a REAL Node runtime: Electron's binary (even with
 * ELECTRON_RUN_AS_NODE) uses Chromium's allocator, which SIGTRAPs on
 * the large dictation model's multi-GB allocations (reproduced
 * 2026-06-10; system Node loads it fine). Resolution order:
 *  1. CARDMIRROR_NODE env
 *  2. shipped runtime (resources/voice/node, fetched at build time)
 *  3. system node on PATH
 * Falling back to electron-as-node still works for the STANDARD model;
 * the large model is then disabled with an explicit flag.
 */
/** Filesystem path to the forked recognizer worker. In a packaged
 *  build the worker is forked under a REAL Node (execPath: nodeBin),
 *  which has no asar support and so cannot load worker.js from inside
 *  app.asar — the require fails with MODULE_NOT_FOUND. electron-builder's
 *  `asarUnpack` keeps dist/voice/** (and koffi) on disk under
 *  app.asar.unpacked; rewrite the path to point there. In dev __dirname
 *  is an ordinary directory with no `app.asar` segment, so the replace
 *  is a no-op and the real dist path is used. */
function resolveWorkerPath(): string {
  const p = path.join(__dirname, 'worker.js');
  return p.replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`);
}

function resolveNodeBinary(): string | null {
  const candidates = [
    process.env.CARDMIRROR_NODE,
    path.join(process.resourcesPath, 'voice', process.platform === 'win32' ? 'node.exe' : 'node'),
  ].filter((c): c is string => !!c);
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  try {
    const { execSync } = require('node:child_process') as typeof import('node:child_process');
    const found = execSync(process.platform === 'win32' ? 'where node' : 'command -v node', {
      encoding: 'utf8',
    })
      .trim()
      .split('\n')[0];
    if (found && fs.existsSync(found)) return found;
  } catch {
    /* no system node */
  }
  return null;
}

function stopSession(): void {
  worker?.kill();
  worker = null;
  ownerWebContentsId = null;
  ownerCleanup?.();
  ownerCleanup = null;
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
    // 30-minute overall ceiling — a stalled download must not pin
    // downloadInFlight forever (audit 2026-06-10).
    const res = await fetch(LARGE_MODEL_URL, {
      redirect: 'follow',
      signal: AbortSignal.timeout(30 * 60 * 1000),
    });
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
    // Async extraction — execFileSync of a 1.8 GB zip froze the whole
    // main process (audit 2026-06-10).
    const { execFile } = await import('node:child_process');
    const run = (cmd: string, args: string[]) =>
      new Promise<void>((resolve, reject) =>
        execFile(cmd, args, (err) => (err ? reject(err) : resolve())),
      );
    try {
      await run('unzip', ['-oq', zipPath, '-d', root]);
    } catch {
      await run('tar', ['-xf', zipPath, '-C', root]);
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
      // macOS: the renderer's getUserMedia can "succeed" yet deliver a
      // SILENT track until the OS-level microphone permission is granted —
      // the audio graph runs but every sample is zero. Ask for (and, on
      // first use, prompt for) access before capture starts. Requires
      // NSMicrophoneUsageDescription in the Info.plist (see package.json
      // build.mac.extendInfo); a no-op once granted, and a no-op off macOS.
      if (process.platform === 'darwin') {
        try {
          const granted = await systemPreferences.askForMediaAccess('microphone');
          if (!granted) return { ok: false, error: 'voice-mic-denied' };
        } catch {
          return { ok: false, error: 'voice-mic-denied' };
        }
      }
      if (worker) stopSession(); // same window restarting — rebuild cleanly
      const assets = opts.modelDir
        ? { libPath: resolveVoiceAssets()?.libPath ?? '', modelDir: opts.modelDir }
        : resolveVoiceAssets();
      if (!assets || !fs.existsSync(assets.libPath)) {
        return { ok: false, error: 'voice-assets-missing' };
      }

      // Plain Node child, NOT utilityProcess (see resolveNodeBinary).
      // Advanced serialization structured-clones the audio chunks.
      const nodeBin = resolveNodeBinary();
      const wantLarge = opts.dictationModel === 'large' && largeModelPresent();
      const largeUnsupported = wantLarge && !nodeBin;
      const child = fork(resolveWorkerPath(), [], {
        ...(nodeBin
          ? { execPath: nodeBin, env: { ...process.env } }
          : { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } }),
        serialization: 'advanced',
        stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      });
      worker = child;
      ownerWebContentsId = sender.id;

      const started = await new Promise<VoiceStartResult>((resolve) => {
        // 60 s: the large dictation model alone takes ~10 s to load
        // warm, more on cold disk cache.
        const timeout = setTimeout(() => resolve({ ok: false, error: 'voice-worker-timeout' }), 60000);
        child.once('message', (m: { type: string; modelLoadMs?: number; error?: string }) => {
          clearTimeout(timeout);
          if (m.type === 'started') resolve({ ok: true, modelLoadMs: m.modelLoadMs });
          else resolve({ ok: false, error: m.error ?? 'voice-worker-error' });
        });
        child.once('exit', () => {
          clearTimeout(timeout);
          resolve({ ok: false, error: 'voice-worker-died' });
        });
        child.send({
          type: 'start',
          libPath: assets.libPath,
          modelDir: assets.modelDir,
          dictationModelDir: wantLarge && nodeBin ? largeModelDir() : undefined,
          rmsGate: opts.rmsGate,
          minWordConf: opts.minWordConf,
          autoSleepSeconds: opts.autoSleepSeconds,
        });
      });
      if (!started.ok) {
        // Audit 2026-06-10: this used to call stopSession()
        // unconditionally — if a NEWER session had already replaced
        // `worker`, the stale failure path killed the new session.
        if (worker === child) stopSession();
        else child.kill();
        return started;
      }
      if (opts.dictationModel === 'large' && !largeModelPresent()) {
        started.largeDictationMissing = true;
      }
      if (largeUnsupported) started.largeDictationUnsupported = true;

      child.on('message', (m: { type: string; event?: unknown; level?: unknown }) => {
        if (sender.isDestroyed()) return;
        if (m.type === 'event') sender.send('voice:event', m.event);
        else if (m.type === 'level') sender.send('voice:level', m.level);
      });
      child.on('exit', (code) => {
        // Crash isolation: the editor survives; the session just ends —
        // and the renderer is TOLD (audit 2026-06-10: it used to keep
        // capturing into a dead session with the pill stuck on
        // "listening").
        if (worker === child) {
          console.error(`voice: worker exited (code ${code})`);
          if (!sender.isDestroyed()) {
            sender.send('voice:event', { kind: 'ended', reason: `recognizer exited (${code ?? '?'})` });
          }
          stopSession();
        }
      });
      const onGone = (): void => {
        if (ownerWebContentsId === sender.id) stopSession();
      };
      sender.once('destroyed', onGone);
      // Reload/navigation keeps the same webContents id but loses the
      // renderer-side session — without these the worker (and a loaded
      // multi-GB model) ran on with no consumer (audit 2026-06-10).
      sender.once('did-start-navigation', onGone);
      sender.once('render-process-gone', onGone);
      ownerCleanup = () => {
        sender.removeListener('destroyed', onGone);
        sender.removeListener('did-start-navigation', onGone);
        sender.removeListener('render-process-gone', onGone);
      };
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
    if (!(chunk instanceof ArrayBuffer)) return; // never crash the worker
    try {
      worker.send({ type: 'audio', chunk });
    } catch {
      // Worker exited between the null-check and the post — the exit
      // handler is about to clean up; dropping one chunk is fine.
    }
  });

  // True native key synthesis for voice "press <key>" — DOM-dispatched
  // KeyboardEvents are untrusted and can't drive default actions in
  // real inputs (audit 2026-06-10).
  const SEND_KEYS: Record<string, string> = {
    enter: 'Return', tab: 'Tab', escape: 'Escape', up: 'Up', down: 'Down',
    left: 'Left', right: 'Right', space: 'Space', backspace: 'Backspace',
  };
  ipcMain.handle('host:voice-send-key', async (event, key: string) => {
    if (ownerWebContentsId !== event.sender.id) return;
    const keyCode = SEND_KEYS[key];
    if (!keyCode) return;
    event.sender.sendInputEvent({ type: 'keyDown', keyCode });
    if (key === 'space') event.sender.sendInputEvent({ type: 'char', keyCode: ' ' });
    event.sender.sendInputEvent({ type: 'keyUp', keyCode });
  });

  ipcMain.handle('host:voice-set-vocabulary', async (event, docText: string) => {
    if (ownerWebContentsId !== event.sender.id || !worker) return;
    worker.send({ type: 'vocab', text: typeof docText === 'string' ? docText : '' });
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
