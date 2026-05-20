/**
 * BrowserHost — the Host implementation for the plain web edition
 * (and, by extension, the installable PWA). All file I/O goes
 * through web platform APIs: `<input type="file">` for opens,
 * `showSaveFilePicker` (Chromium) or a synthesized `<a download>`
 * link (everyone else) for saves.
 *
 * The hidden file-input that opens files is owned and recycled by
 * this class — callers don't see it. We allow only one open dialog
 * to be pending at a time (browsers serialize them anyway).
 */

import type {
  FileFilter,
  Host,
  JournalEntry,
  OpenFileOptions,
  OpenedFile,
  SaveAsOptions,
  SaveResult,
  SpawnWindowPayload,
} from './types.js';

const DOCX_MIME =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/** Best-effort MIME guess for a given extension. The browser's
 *  showSaveFilePicker uses MIME → extension mapping to label the
 *  format dropdown; getting this right makes the dialog read
 *  naturally. */
function mimeForExtension(ext: string): string {
  if (ext === 'docx') return DOCX_MIME;
  if (ext === 'cmir') return 'application/json';
  return 'application/octet-stream';
}

/** Chrome's File System Access API is gated by feature detection. */
interface ShowSaveFilePickerOptions {
  suggestedName?: string;
  types?: { description: string; accept: Record<string, string[]> }[];
}
interface FileSystemFileHandle {
  name?: string;
  createWritable(): Promise<{
    write(data: Blob | ArrayBuffer | Uint8Array): Promise<void>;
    close(): Promise<void>;
  }>;
}
type ShowSaveFilePicker = (
  opts: ShowSaveFilePickerOptions,
) => Promise<FileSystemFileHandle>;

function getShowSaveFilePicker(): ShowSaveFilePicker | undefined {
  return (window as unknown as { showSaveFilePicker?: ShowSaveFilePicker })
    .showSaveFilePicker;
}

function filtersToAcceptAttribute(filters?: FileFilter[]): string {
  if (!filters || filters.length === 0) return '';
  const exts = new Set<string>();
  for (const f of filters) {
    for (const e of f.extensions) exts.add(`.${e}`);
  }
  return Array.from(exts).join(',');
}

function filtersToSavePickerTypes(filters?: FileFilter[]): ShowSaveFilePickerOptions['types'] {
  if (!filters || filters.length === 0) return undefined;
  return filters.map((f) => {
    const accept: Record<string, string[]> = {};
    for (const ext of f.extensions) {
      const mime = mimeForExtension(ext);
      const existing = accept[mime] ?? [];
      existing.push(`.${ext}`);
      accept[mime] = existing;
    }
    return { description: f.name, accept };
  });
}

/** Opened IndexedDB connection. Lazily created on first journal
 *  operation; reused for subsequent calls. */
let dbPromise: Promise<IDBDatabase> | null = null;

const DB_NAME = 'cardmirror';
const DB_VERSION = 1;
const STORE_JOURNALS = 'journals';

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('BrowserHost: IndexedDB unavailable.'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (): void => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_JOURNALS)) {
        db.createObjectStore(STORE_JOURNALS, { keyPath: 'uid' });
      }
    };
    req.onsuccess = (): void => resolve(req.result);
    req.onerror = (): void => reject(req.error ?? new Error('IndexedDB open failed.'));
  });
  return dbPromise;
}

function browserJournalsSupported(): boolean {
  return typeof indexedDB !== 'undefined';
}

export class BrowserHost implements Host {
  readonly kind = 'browser' as const;
  readonly journalsSupported = browserJournalsSupported();
  readonly canSpawnWindow = false;

  get supportsInPlaceSave(): boolean {
    // showSaveFilePicker gives us a writable handle that survives
    // back to disk. Without it, fallback saves go through a
    // download link and there's no persistent reference.
    return typeof getShowSaveFilePicker() === 'function';
  }

  /** Lazily-created hidden file input. Reused across opens. */
  private fileInput: HTMLInputElement | null = null;

  /** Serialize concurrent openFile() calls so two near-simultaneous
   *  opens don't step on each other's event listeners. */
  private openInFlight: Promise<OpenedFile | null> = Promise.resolve(null);

  async openFile(opts: OpenFileOptions = {}): Promise<OpenedFile | null> {
    const next = this.openInFlight.then(() => this.openOnce(opts));
    this.openInFlight = next.then(
      () => null,
      () => null,
    );
    return next;
  }

  private openOnce(opts: OpenFileOptions): Promise<OpenedFile | null> {
    const input = this.ensureFileInput();
    // Reapply the accept attribute from the caller's filters on
    // every open — different call sites may want different filters
    // (the ribbon Open accepts both formats; a hypothetical
    // "import .docx only" command could pass just docx).
    const accept = filtersToAcceptAttribute(opts.filters);
    if (accept) input.setAttribute('accept', accept);
    else input.removeAttribute('accept');

    return new Promise((resolve, reject) => {
      // Browser quirk: if the user picks the same filename twice in
      // a row, the second `change` event won't fire unless `.value`
      // is cleared. Reset every time to be safe.
      input.value = '';

      let settled = false;
      const cleanup = (): void => {
        input.removeEventListener('change', onChange);
        input.removeEventListener('cancel', onCancel);
      };
      const onChange = async (): Promise<void> => {
        if (settled) return;
        settled = true;
        cleanup();
        const file = input.files?.[0];
        if (!file) {
          resolve(null);
          return;
        }
        try {
          const buf = await file.arrayBuffer();
          resolve({
            name: file.name,
            bytes: new Uint8Array(buf),
          });
        } catch (err) {
          reject(err);
        }
      };

      // `cancel` is the modern (Chrome 113+, Firefox 91+, Safari
      // 16.4+) signal that the user closed the picker without
      // picking anything. Before it existed we polled focus + a
      // 200ms timeout, which raced the `change` event when the
      // browser was slow to populate `input.files` after the dialog
      // closed (especially when the dialog was opened by a button
      // click rather than a keyboard shortcut — different focus
      // path through the activeElement). The cancel event removes
      // the race; if the browser is old enough to lack it, the
      // promise just stays pending on cancel — minor leak, no
      // false null resolve that drops a real selection.
      const onCancel = (): void => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(null);
      };

      input.addEventListener('change', onChange);
      input.addEventListener('cancel', onCancel);
      input.click();
    });
  }

  async saveAs(
    suggestedName: string,
    bytes: Uint8Array,
    opts: SaveAsOptions = {},
  ): Promise<SaveResult | null> {
    const blob = bytesToBlob(bytes, suggestedName);

    const showSaveFilePicker = getShowSaveFilePicker();
    if (typeof showSaveFilePicker === 'function') {
      let handle: FileSystemFileHandle;
      try {
        handle = await showSaveFilePicker({
          suggestedName,
          types: filtersToSavePickerTypes(opts.filters),
        });
      } catch (e) {
        // AbortError = user cancelled the OS dialog. Quietly bail.
        if (e instanceof DOMException && e.name === 'AbortError') {
          return null;
        }
        throw e;
      }
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      return {
        name: handle.name ?? suggestedName,
        handle,
      };
    }

    // Fallback: synthesize a download link.
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = suggestedName;
    a.click();
    URL.revokeObjectURL(url);
    return { name: suggestedName };
  }

  async saveExisting(handle: unknown, bytes: Uint8Array): Promise<void> {
    if (!handle || typeof (handle as FileSystemFileHandle).createWritable !== 'function') {
      throw new Error('BrowserHost: saveExisting requires a File System Access handle.');
    }
    const fh = handle as FileSystemFileHandle;
    const blob = bytesToBlob(bytes, fh.name ?? '');
    const writable = await fh.createWritable();
    await writable.write(blob);
    await writable.close();
  }

  async writeJournal(entry: JournalEntry): Promise<void> {
    if (!this.journalsSupported) return;
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_JOURNALS, 'readwrite');
      // IndexedDB structured-clones the value, which supports
      // Uint8Array natively. The handle field is `null` for browser
      // — FileSystemFileHandles aren't serializable into the DB.
      // (We could persist them via the FSA API's permission /
      // saved-handle features, but that's future work.)
      tx.objectStore(STORE_JOURNALS).put({ ...entry, handle: null });
      tx.oncomplete = (): void => resolve();
      tx.onerror = (): void => reject(tx.error ?? new Error('writeJournal failed.'));
    });
  }

  async readJournals(): Promise<JournalEntry[]> {
    if (!this.journalsSupported) return [];
    const db = await openDb();
    return new Promise<JournalEntry[]>((resolve, reject) => {
      const tx = db.transaction(STORE_JOURNALS, 'readonly');
      const req = tx.objectStore(STORE_JOURNALS).getAll();
      req.onsuccess = (): void => resolve((req.result as JournalEntry[]) ?? []);
      req.onerror = (): void => reject(req.error ?? new Error('readJournals failed.'));
    });
  }

  async deleteJournal(uid: string): Promise<void> {
    if (!this.journalsSupported) return;
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_JOURNALS, 'readwrite');
      tx.objectStore(STORE_JOURNALS).delete(uid);
      tx.oncomplete = (): void => resolve();
      tx.onerror = (): void => reject(tx.error ?? new Error('deleteJournal failed.'));
    });
  }

  async spawnWindow(_payload: SpawnWindowPayload | null): Promise<void> {
    // Web edition can't meaningfully spawn an editor window from
    // JS. Callers should gate on `canSpawnWindow` before calling
    // — we throw to make the misuse loud rather than silently
    // failing.
    throw new Error('BrowserHost: spawnWindow is not supported on the web edition.');
  }

  async getInitialDoc(): Promise<SpawnWindowPayload | null> {
    // No spawn handshake on the web edition — fresh tabs always
    // boot blank.
    return null;
  }

  async isFirstWindow(): Promise<boolean> {
    // The web edition is single-tab from the editor's POV — there's
    // no spawn mechanism so each tab boots fresh and IS the first
    // window of its session. Returning true preserves the existing
    // recovery prompt on every web load.
    return true;
  }

  private ensureFileInput(): HTMLInputElement {
    if (this.fileInput) return this.fileInput;
    const input = document.createElement('input');
    input.type = 'file';
    input.hidden = true;
    document.body.appendChild(input);
    this.fileInput = input;
    return input;
  }
}

/** Build a Blob from a Uint8Array, picking a reasonable MIME type
 *  from the filename extension. */
function bytesToBlob(bytes: Uint8Array, filename: string): Blob {
  // Copy into a regular ArrayBuffer so Blob's BlobPart contract is
  // happy. Some TypedArray backing buffers are SharedArrayBuffer in
  // worker contexts; Blob doesn't accept those directly.
  const ab = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(ab).set(bytes);
  const ext = filename.toLowerCase().split('.').pop() ?? '';
  return new Blob([ab], { type: mimeForExtension(ext) });
}
