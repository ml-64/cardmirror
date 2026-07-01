/**
 * Web single-file document tools (Clean / Convert / Compress) — the browser
 * counterpart to the desktop folder-recursive modals. The web edition can't walk
 * a directory, so each tool takes ONE file: pick it, run the transform behind a
 * progress modal, then Save-As the result (File System Access picker on
 * Chromium, download elsewhere).
 *
 * The transforms are heavy and CPU-bound (Clean especially) and block the main
 * thread, so the modal's spinner is a compositor-driven `transform: rotate`
 * animation that keeps turning even while the main thread is busy — and we let
 * the modal paint (two rAFs) before starting the work.
 */

import { getHost } from './host/index.js';
import { showToast } from './toast.js';
import type { FileFilter } from './host/types.js';

export interface WebFileToolResult {
  bytes: Uint8Array;
  /** Suggested output filename for the Save-As picker. */
  outputName: string;
  filter: FileFilter;
  /** Optional toast shown after a successful save (e.g. a size reduction). */
  doneToast?: string;
}

export interface WebFileTool {
  /** Human label for error messages, e.g. "Clean". */
  label: string;
  /** Present-participle shown in the progress modal, e.g. "Cleaning". */
  verb: string;
  /** Accepted input extensions. */
  accept: RegExp;
  /** Message shown when the picked file doesn't match `accept`. */
  acceptMsg: string;
  /** Transform the picked bytes into the output + its save metadata. */
  run: (bytes: Uint8Array, name: string) => Promise<WebFileToolResult>;
}

/** Run a single-file web tool end to end: pick → validate → transform (behind a
 *  progress modal) → Save-As → optional result toast. */
export async function runWebFileTool(tool: WebFileTool): Promise<void> {
  const host = getHost();
  const input = await host.openFile().catch((err: unknown) => {
    alert(`Couldn't open the file: ${err instanceof Error ? err.message : err}`);
    return null;
  });
  if (!input) return;
  if (!tool.accept.test(input.name)) {
    alert(tool.acceptMsg);
    return;
  }
  const modal = showProgressModal(`${tool.verb} “${input.name}”…`);
  let result: WebFileToolResult;
  try {
    // Let the modal actually paint before the main-thread-blocking transform.
    await nextPaint();
    result = await tool.run(input.bytes, input.name);
  } catch (err) {
    modal.close();
    alert(`${tool.label} failed: ${err instanceof Error ? err.message : err}`);
    return;
  }
  modal.close();
  const saved = await host.saveAs(result.outputName, result.bytes, {
    filters: [result.filter],
  });
  if (saved && result.doneToast) showToast(result.doneToast);
}

/** Two rAFs ≈ one committed paint, so the modal is on screen before we block. */
function nextPaint(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}

function showProgressModal(text: string): { close: () => void } {
  const overlay = document.createElement('div');
  overlay.className = 'pmd-route-overlay';
  const dialog = document.createElement('div');
  dialog.className = 'pmd-route-dialog pmd-file-tool-progress';
  const spinner = document.createElement('div');
  spinner.className = 'pmd-file-tool-spinner';
  spinner.setAttribute('aria-hidden', 'true');
  const label = document.createElement('div');
  label.className = 'pmd-file-tool-progress-label';
  label.setAttribute('role', 'status');
  label.textContent = text;
  dialog.append(spinner, label);
  overlay.appendChild(dialog);
  document.body.appendChild(overlay);
  return { close: () => overlay.remove() };
}
