/**
 * Ribbon tooltip controller. Centralizes title-attribute management
 * for every ribbon-side button + dropdown menu item so a single
 * setting (`ribbonTooltipMode`) governs what hovering reveals,
 * and so the displayed keyboard shortcut tracks user rebinds via
 * `ribbonKeyOverrides` automatically.
 *
 * Modes (`settings.ribbonTooltipMode`):
 *   - `none`     — no tooltips on any ribbon target.
 *   - `tooltip`  — buttons show the action label; dropdown items
 *                  show nothing (their menu label already does).
 *   - `shortcut` — only the current shortcut, on both buttons and
 *                  dropdown items. Targets without a shortcut get
 *                  no tooltip.
 *   - `both`     — buttons show `Label (Shortcut)` (or just label
 *                  if no shortcut); dropdown items show shortcut-
 *                  only (label is in the menu).
 *
 * Call sites register a target with `registerRibbonTooltip(...)`,
 * which applies the tooltip immediately. The settings subscriber
 * calls `reapplyAllRibbonTooltips()` whenever
 * `ribbonTooltipMode` or `ribbonKeyOverrides` changes so tooltips
 * stay in sync with rebinds and mode flips.
 */

import { settings } from './settings.js';
import {
  primaryKeyFor,
  formatKeyForDisplay,
  RIBBON_COMMAND_LABELS,
  type RibbonCommandId,
} from './ribbon-commands.js';

export interface RibbonTooltipTarget {
  el: HTMLElement;
  /** A command id to derive both label (via RIBBON_COMMAND_LABELS)
   *  and shortcut (via primaryKeyFor + formatKeyForDisplay). Pass
   *  this for any button that maps 1:1 to a ribbon command. */
  commandId?: RibbonCommandId;
  /** Explicit label override. Used for buttons whose tooltip text
   *  doesn't match `RIBBON_COMMAND_LABELS[commandId]` (e.g., state-
   *  aware autosave toggle, plain-paste toggle). Falls back to the
   *  command-id-derived label when omitted. */
  label?: string;
  /** A dropdown menu item rather than a top-level button. Affects
   *  `tooltip` and `both` modes: menu items never show their label
   *  (the menu already does), only the shortcut-or-nothing. */
  kind?: 'button' | 'menuItem';
}

const targets: RibbonTooltipTarget[] = [];

export function registerRibbonTooltip(t: RibbonTooltipTarget): void {
  // De-dup if the same element is registered twice — last one wins.
  const existing = targets.findIndex((x) => x.el === t.el);
  if (existing >= 0) targets.splice(existing, 1);
  targets.push(t);
  applyOne(t);
}

export function unregisterRibbonTooltip(el: HTMLElement): void {
  const idx = targets.findIndex((x) => x.el === el);
  if (idx >= 0) targets.splice(idx, 1);
}

export function reapplyAllRibbonTooltips(): void {
  for (const t of targets) applyOne(t);
}

function applyOne(t: RibbonTooltipTarget): void {
  const mode = settings.get('ribbonTooltipMode');
  const label =
    t.label ?? (t.commandId ? RIBBON_COMMAND_LABELS[t.commandId] : '');
  let shortcut: string | null = null;
  if (t.commandId) {
    const key = primaryKeyFor(t.commandId, settings.get('ribbonKeyOverrides'));
    if (key) shortcut = formatKeyForDisplay(key);
  }
  const kind = t.kind ?? 'button';
  const title = composeTitle(mode, kind, label, shortcut);
  if (title) t.el.title = title;
  else t.el.removeAttribute('title');
}

function composeTitle(
  mode: 'none' | 'tooltip' | 'shortcut' | 'both',
  kind: 'button' | 'menuItem',
  label: string,
  shortcut: string | null,
): string {
  if (mode === 'none') return '';
  if (kind === 'menuItem') {
    // Menu items never repeat the label (it's already in the menu).
    return mode === 'shortcut' || mode === 'both' ? shortcut ?? '' : '';
  }
  // Top-level button.
  switch (mode) {
    case 'tooltip': return label;
    case 'shortcut': return shortcut ?? '';
    case 'both':
      if (!label) return shortcut ?? '';
      return shortcut ? `${label} (${shortcut})` : label;
  }
}
