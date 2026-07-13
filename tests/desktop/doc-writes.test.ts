// @vitest-environment node
/**
 * The document write pipeline (doc-writes.ts) — regression coverage for
 * the field failure modes behind the 2026-07 save reports:
 *
 *  - a file renamed/deleted in Finder while open must FAIL the next
 *    in-place save with ENOENT (the old bare writeFile silently
 *    recreated the file at the stale path, forking the document);
 *  - a file rewritten by another program/device (Dropbox syncing down
 *    another machine's edit) must be refused with an EMODIFIED-marked
 *    error unless the caller passes force (the user's explicit
 *    "Overwrite" choice);
 *  - writes stage into a hidden tmp sibling then rename (no torn docs,
 *    no leftovers), and writes to one path are serialized.
 *
 * Real-fs tests in a per-run temp dir — the module IS the disk layer,
 * so mocking fs would test nothing.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  saveExistingDoc,
  saveNewDoc,
  chainDocWrite,
  recordDiskStateFromDisk,
  resetDocWritesForTests,
  CHANGED_ON_DISK_MARKER,
} from '../../apps/desktop/src/doc-writes.js';

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cardmirror-doc-writes-'));
let caseDir: string;
let n = 0;

beforeEach(async () => {
  resetDocWritesForTests();
  caseDir = path.join(tmpRoot, `case-${n++}`);
  await fs.mkdir(caseDir, { recursive: true });
});

afterAll(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

const docPath = (name = 'doc.cmir'): string => path.join(caseDir, name);
const read = (p: string): Promise<string> => fs.readFile(p, 'utf8');
const exists = async (p: string): Promise<boolean> =>
  fs.stat(p).then(
    () => true,
    () => false,
  );

/** Open-then-save baseline: the file exists and we've recorded what it
 *  looks like, exactly as a real document open does via readDocumentBytes. */
async function openedDoc(content = 'original', name?: string): Promise<string> {
  const p = docPath(name);
  await fs.writeFile(p, content);
  await recordDiskStateFromDisk(p);
  return p;
}

describe('saveExistingDoc — existence check (renamed/deleted file)', () => {
  it('saves in place when the file is present and unchanged', async () => {
    const p = await openedDoc();
    await saveExistingDoc(p, Buffer.from('v2'));
    expect(await read(p)).toBe('v2');
  });

  it('rejects with ENOENT when the file was deleted — and does NOT recreate it', async () => {
    const p = await openedDoc();
    await fs.unlink(p);
    await expect(saveExistingDoc(p, Buffer.from('v2'))).rejects.toThrow(/ENOENT/);
    // The old bare writeFile resurrected the file here; the fork bug.
    expect(await exists(p)).toBe(false);
  });

  it('rejects with ENOENT at the OLD path after a rename — the renamed file is untouched', async () => {
    const p = await openedDoc();
    const renamed = docPath('renamed.cmir');
    await fs.rename(p, renamed);
    await expect(saveExistingDoc(p, Buffer.from('v2'))).rejects.toThrow(/ENOENT/);
    expect(await exists(p)).toBe(false); // no silent fork at the stale path
    expect(await read(renamed)).toBe('original');
  });
});

describe('saveExistingDoc — changed-on-disk guard', () => {
  it('refuses to overwrite a file another program rewrote (size change)', async () => {
    const p = await openedDoc('original');
    await fs.writeFile(p, 'rewritten by another machine'); // different size
    await expect(saveExistingDoc(p, Buffer.from('v2'))).rejects.toThrow(
      new RegExp(CHANGED_ON_DISK_MARKER),
    );
    expect(await read(p)).toBe('rewritten by another machine'); // their version survives
  });

  it('refuses on an mtime-only change (same size)', async () => {
    const p = await openedDoc('original');
    await fs.writeFile(p, 'ORIGINAL'); // same byte length
    // Force a distinct mtime regardless of filesystem timestamp granularity.
    const st = await fs.stat(p);
    await fs.utimes(p, st.atime, new Date(st.mtimeMs + 5000));
    await expect(saveExistingDoc(p, Buffer.from('v2'))).rejects.toThrow(
      new RegExp(CHANGED_ON_DISK_MARKER),
    );
  });

  it('force (the explicit Overwrite choice) writes and re-baselines', async () => {
    const p = await openedDoc('original');
    await fs.writeFile(p, 'rewritten elsewhere');
    await saveExistingDoc(p, Buffer.from('v2'), { force: true });
    expect(await read(p)).toBe('v2');
    // The force write re-recorded the baseline: a normal save now passes.
    await saveExistingDoc(p, Buffer.from('v3'));
    expect(await read(p)).toBe('v3');
  });

  it('skips the guard for paths with no recorded baseline (journal recovery after restart)', async () => {
    const p = docPath();
    await fs.writeFile(p, 'pre-crash contents');
    // No recordDiskStateFromDisk — a fresh process saving a recovered doc.
    await saveExistingDoc(p, Buffer.from('recovered'));
    expect(await read(p)).toBe('recovered');
  });

  it("our own writes don't trip the guard (each save re-baselines)", async () => {
    const p = await openedDoc();
    await saveExistingDoc(p, Buffer.from('v2'));
    await saveExistingDoc(p, Buffer.from('v3 — longer'));
    await saveExistingDoc(p, Buffer.from('v4'));
    expect(await read(p)).toBe('v4');
  });

  it('saveNewDoc (Save As) baselines the path for later in-place saves', async () => {
    const p = docPath('new.cmir');
    await saveNewDoc(p, Buffer.from('first version'));
    expect(await read(p)).toBe('first version');
    // External rewrite after the Save As is caught by the next save…
    await fs.writeFile(p, 'external edit after save-as!');
    await expect(saveExistingDoc(p, Buffer.from('v2'))).rejects.toThrow(
      new RegExp(CHANGED_ON_DISK_MARKER),
    );
  });
});

describe('atomic writes', () => {
  it('leaves no tmp sibling behind and preserves content byte-for-byte', async () => {
    const p = await openedDoc();
    const payload = 'x'.repeat(64 * 1024);
    await saveExistingDoc(p, Buffer.from(payload));
    expect(await read(p)).toBe(payload);
    const leftovers = (await fs.readdir(caseDir)).filter((f) => f.includes('.cmtmp'));
    expect(leftovers).toEqual([]);
  });

  it('saveNewDoc creates missing parent folders when asked (bulk convert / send doc)', async () => {
    const p = path.join(caseDir, 'sub', 'deeper', 'out.cmir');
    await saveNewDoc(p, Buffer.from('exported'), { mkdir: true });
    expect(await read(p)).toBe('exported');
  });

  it('preserves the existing file mode across the tmp+rename', async () => {
    if (process.platform === 'win32') return; // POSIX modes only
    const p = await openedDoc();
    await fs.chmod(p, 0o600);
    await saveExistingDoc(p, Buffer.from('v2'));
    expect((await fs.stat(p)).mode & 0o777).toBe(0o600);
  });
});

describe('chainDocWrite — per-path serialization', () => {
  it('runs same-path writes strictly in order (no overlap)', async () => {
    const p = docPath();
    const events: string[] = [];
    let releaseFirst!: () => void;
    const gate = new Promise<void>((r) => {
      releaseFirst = r;
    });
    const first = chainDocWrite(p, async () => {
      events.push('first:start');
      await gate;
      events.push('first:end');
    });
    const second = chainDocWrite(p, async () => {
      events.push('second:start');
    });
    // Give the second task every chance to start early if the chain leaked.
    await new Promise((r) => setTimeout(r, 20));
    expect(events).toEqual(['first:start']);
    releaseFirst();
    await Promise.all([first, second]);
    expect(events).toEqual(['first:start', 'first:end', 'second:start']);
  });

  it('a failed write does not dam the queue — the next write still runs', async () => {
    const p = docPath();
    const first = chainDocWrite(p, async () => {
      throw new Error('disk on fire');
    });
    const second = chainDocWrite(p, async () => 'ran');
    await expect(first).rejects.toThrow('disk on fire');
    await expect(second).resolves.toBe('ran');
  });

  it('the manual-⌘S-during-autosave interleave: both writes land, last writer wins', async () => {
    const p = await openedDoc();
    await Promise.all([
      saveExistingDoc(p, Buffer.from('autosave bytes')),
      saveExistingDoc(p, Buffer.from('manual save bytes')),
    ]);
    expect(await read(p)).toBe('manual save bytes');
  });
});
