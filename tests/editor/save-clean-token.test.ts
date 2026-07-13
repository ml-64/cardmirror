// @vitest-environment node
/**
 * The clean token (save-clean-token.ts) — the guard that stops a save
 * from marking keystrokes clean that landed WHILE its serialize/write
 * was in flight. Field consequence of the old unconditional clear: type
 * during an autosave write → doc marked clean → close skips the save
 * prompt AND drops the recovery journal → those keystrokes are gone.
 */
import { describe, it, expect, vi } from 'vitest';
import { captureCleanToken, type CleanTokenTarget } from '../../src/editor/save-clean-token.js';

function target(): CleanTokenTarget & { gen: number; markClean: any; clearJournal: any } {
  const t = {
    gen: 0,
    editGen: () => t.gen,
    markClean: vi.fn(),
    clearJournal: vi.fn(),
  };
  return t;
}

describe('captureCleanToken', () => {
  it('marks clean + clears the journal when nothing changed during the save', () => {
    const t = target();
    const commit = captureCleanToken(t);
    expect(commit()).toBe(true);
    expect(t.markClean).toHaveBeenCalledTimes(1);
    expect(t.clearJournal).toHaveBeenCalledTimes(1);
  });

  it('an edit during the write keeps the doc dirty AND keeps the journal', () => {
    const t = target();
    const commit = captureCleanToken(t);
    t.gen++; // keystroke while the serialize/write was in flight
    expect(commit()).toBe(false);
    expect(t.markClean).not.toHaveBeenCalled();
    expect(t.clearJournal).not.toHaveBeenCalled();
  });

  it('a doc swap (Open/New/recovery bumps the generation) invalidates in-flight tokens', () => {
    const t = target();
    const commit = captureCleanToken(t);
    t.gen++; // markCurrentDocClean() on the swap path bumps too
    expect(commit()).toBe(false);
    expect(t.markClean).not.toHaveBeenCalled();
  });

  it('two saves in flight for the same generation both commit (autosave + manual ⌘S)', () => {
    // markClean must not bump the generation, or the second commit
    // would wrongly fail and strand the doc dirty forever.
    const t = target();
    const autosaveCommit = captureCleanToken(t);
    const manualCommit = captureCleanToken(t);
    expect(autosaveCommit()).toBe(true);
    expect(manualCommit()).toBe(true);
    expect(t.markClean).toHaveBeenCalledTimes(2);
  });

  it('tokens are independent across generations: only the fresh one commits', () => {
    const t = target();
    const stale = captureCleanToken(t);
    t.gen++;
    const fresh = captureCleanToken(t);
    expect(stale()).toBe(false);
    expect(fresh()).toBe(true);
  });
});
