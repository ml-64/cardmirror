// @vitest-environment jsdom
/**
 * The web-only header buttons must be STRUCTURALLY absent in the desktop
 * app — regression for the 0.1.0-beta.14 field bug, where they shipped
 * visible in the desktop build: their `hidden` attribute was silently
 * defeated by `#ribbon button { display: inline-flex }` (author CSS beats
 * the UA sheet's `[hidden] { display: none }`). The wiring now REMOVES
 * the nodes under an Electron host, which no styling can undo.
 *
 * Host detection reads `window.electronAPI` once and caches — each case
 * resets modules and re-imports so it gets a fresh detection.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

function mountCluster(): void {
  document.body.innerHTML = `
    <div class="ribbon-right-grid">
      <button id="download-app-btn" hidden></button>
      <button id="reference-btn"></button>
      <button id="settings-btn"></button>
      <button id="github-btn" hidden></button>
      <button id="timer-toggle-btn"></button>
      <button id="home-btn"></button>
    </div>`;
}

async function wireFresh(): Promise<void> {
  vi.resetModules(); // fresh host cache → re-reads window.electronAPI
  const mod = await import('../../src/editor/web-download.js');
  mod.wireWebEditionHeaderButtons();
}

beforeEach(() => {
  mountCluster();
  delete (window as { electronAPI?: unknown }).electronAPI;
});

describe('wireWebEditionHeaderButtons', () => {
  it('desktop (Electron host): the buttons are REMOVED from the DOM, grid stays 2×2', async () => {
    (window as { electronAPI?: unknown }).electronAPI = {};
    await wireFresh();
    expect(document.getElementById('download-app-btn')).toBeNull();
    expect(document.getElementById('github-btn')).toBeNull();
    expect(
      document.querySelector('.ribbon-right-grid')!.classList.contains('pmd-web-buttons'),
    ).toBe(false);
    // The four standard buttons are untouched.
    expect(document.querySelectorAll('.ribbon-right-grid button').length).toBe(4);
  });

  it('web (no Electron host): the buttons are revealed and the grid gains its third column', async () => {
    await wireFresh();
    const download = document.getElementById('download-app-btn')!;
    const github = document.getElementById('github-btn')!;
    expect(download.hidden).toBe(false);
    expect(github.hidden).toBe(false);
    expect(
      document.querySelector('.ribbon-right-grid')!.classList.contains('pmd-web-buttons'),
    ).toBe(true);
  });
});
