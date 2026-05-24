/**
 * "Doc" dropdown menu — Verbatim parity. A grouped popover of
 * document-level utilities (currently just standardize-highlighting /
 * standardize-shading, sectioned under "Highlighting" so additional
 * groups can land here as we ship more Verbatim functions). Anchored
 * to the Doc button in the ribbon; positioned via fixed coordinates
 * derived from the anchor's bounding rect so it stays flush
 * regardless of page scroll / browser zoom — same approach the color
 * pickers use.
 */

import type { EditorView } from 'prosemirror-view';
import {
  registerRibbonTooltip,
  unregisterRibbonTooltip,
} from './ribbon-tooltips.js';
import type { RibbonCommandId } from './ribbon-commands.js';

export interface DocMenuItem {
  label: string;
  /** Optional ribbon command id — when provided, the menu item
   *  registers with the ribbon-tooltip controller so the item's
   *  title attribute carries the current keybinding (or is empty
   *  per the user's `ribbonTooltipMode`). Menu items never repeat
   *  the label in the tooltip; only the shortcut. */
  commandId?: RibbonCommandId;
  /** Returns whether the action ran (currently informational only;
   *  the menu always closes after click). */
  run: (view: EditorView) => void;
}

export interface DocMenuSection {
  title: string;
  items: DocMenuItem[];
}

let openMenuEl: HTMLElement | null = null;
let onDocPointerDown: ((e: PointerEvent) => void) | null = null;
let onDocKey: ((e: KeyboardEvent) => void) | null = null;

function closeMenu(): void {
  if (!openMenuEl) return;
  // Drop tooltip refs to the menu's buttons before detaching, so
  // the controller's targets array doesn't accumulate stale
  // entries across many open / close cycles.
  for (const btn of openMenuEl.querySelectorAll<HTMLElement>('.pmd-doc-menu-item')) {
    unregisterRibbonTooltip(btn);
  }
  openMenuEl.remove();
  openMenuEl = null;
  if (onDocPointerDown) document.removeEventListener('pointerdown', onDocPointerDown);
  if (onDocKey) document.removeEventListener('keydown', onDocKey);
  onDocPointerDown = null;
  onDocKey = null;
}

export function openDocMenu(
  anchor: HTMLElement,
  view: EditorView | null,
  sections: DocMenuSection[],
): void {
  if (openMenuEl) {
    closeMenu();
    return;
  }
  const menu = document.createElement('div');
  menu.className = 'pmd-doc-menu';

  for (let i = 0; i < sections.length; i++) {
    const section = sections[i]!;
    const header = document.createElement('div');
    header.className = 'pmd-doc-menu-section-title';
    header.textContent = section.title;
    menu.appendChild(header);

    for (const item of section.items) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'pmd-doc-menu-item';
      btn.textContent = item.label;
      btn.addEventListener('mousedown', (e) => e.preventDefault());
      btn.addEventListener('click', () => {
        if (view) item.run(view);
        closeMenu();
        view?.focus();
      });
      if (item.commandId) {
        registerRibbonTooltip({ el: btn, commandId: item.commandId, kind: 'menuItem' });
      }
      menu.appendChild(btn);
    }
    if (i < sections.length - 1) {
      const sep = document.createElement('div');
      sep.className = 'pmd-doc-menu-separator';
      menu.appendChild(sep);
    }
  }

  document.body.appendChild(menu);

  const rect = anchor.getBoundingClientRect();
  menu.style.top = `${rect.bottom + 2}px`;
  menu.style.left = `${rect.left}px`;

  openMenuEl = menu;
  anchor.setAttribute('aria-expanded', 'true');

  onDocPointerDown = (e: PointerEvent) => {
    const t = e.target as Node | null;
    if (t && (menu.contains(t) || anchor.contains(t))) return;
    closeMenu();
    anchor.setAttribute('aria-expanded', 'false');
  };
  onDocKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      closeMenu();
      anchor.setAttribute('aria-expanded', 'false');
    }
  };
  document.addEventListener('pointerdown', onDocPointerDown);
  document.addEventListener('keydown', onDocKey);
}
