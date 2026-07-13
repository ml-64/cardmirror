/**
 * Auto-numbering input commands (NUMBERING_PLAN.md §4) — PROTOTYPE.
 *
 * All three author the SKELETON (node attrs), never a number. `number` and `sub`
 * are mutually exclusive (one `numRole` value), and both operate on the in-scope
 * SET as a whole: the cursor's card, or every card/analytic the selection touches.
 */

import { type Command, type EditorState } from 'prosemirror-state';
import { type Node as PMNode } from 'prosemirror-model';
import type { NumRole } from './numbering.js';
import { settings } from './settings.js';

/** Authoring any part of the skeleton auto-enables the display (§6) — otherwise
 *  the edit is invisible and the user can't tell it worked. */
function ensureNumberingVisible(): void {
  if (!settings.get('showCardNumbering')) settings.set('showCardNumbering', true);
}

interface CardUnit {
  pos: number;
  node: PMNode;
}

/** Provider for the nav pane's explicit multi-selection (set at boot by
 *  index.ts via the active-nav-panel resolver, so it follows the focused
 *  pane in multi-pane mode). Returns the wrapping card/analytic_unit
 *  positions of the selected tag/analytic rows, or null when there's no
 *  such selection — see `NavigationPanel.selectedCardUnitPositions`. */
let navScopeProvider: (() => number[] | null) | null = null;
export function registerNavNumberingScope(provider: () => number[] | null): void {
  navScopeProvider = provider;
}

/** Card / analytic_unit units in scope: the nav pane's explicit
 *  multi-selection when one is active (Shift/Ctrl-click on tag rows —
 *  the toggles then act on those cards "as if selected"), else the
 *  cursor's enclosing unit, or every unit the selection touches. */
function inScopeCardUnits(state: EditorState): CardUnit[] {
  // Nav-pane scope first. Positions come from the SAME view the command
  // runs against (the active-panel resolver tracks focus), but re-check
  // each one resolves to a card/analytic_unit in THIS state anyway —
  // a stale position must drop out, never mis-target a random node.
  const navPositions = navScopeProvider?.();
  if (navPositions && navPositions.length > 0) {
    const units: CardUnit[] = [];
    for (const pos of navPositions) {
      const node = state.doc.nodeAt(pos);
      if (node && (node.type.name === 'card' || node.type.name === 'analytic_unit')) {
        units.push({ pos, node });
      }
    }
    if (units.length > 0) return units;
  }
  const { doc, selection } = state;
  const units: CardUnit[] = [];
  if (selection.empty) {
    const $pos = selection.$from;
    for (let d = $pos.depth; d >= 0; d--) {
      const n = $pos.node(d);
      if (n.type.name === 'card' || n.type.name === 'analytic_unit') {
        units.push({ pos: $pos.before(d), node: n });
        break;
      }
    }
  } else {
    doc.nodesBetween(selection.from, selection.to, (node, pos) => {
      if (node.type.name === 'card' || node.type.name === 'analytic_unit') {
        units.push({ pos, node });
        return false; // a card's internals hold no nested card unit
      }
      return true;
    });
  }
  return units;
}

/**
 * §4 whole-selection toggle. If EVERY in-scope card already has this role → clear
 * them all to 'none' (off). Otherwise (mixed, all-none, or all-the-other-role) →
 * set them all to this role. A lone card is just the one-element case.
 */
function makeRoleToggle(role: 'number' | 'sub'): Command {
  return (state, dispatch) => {
    const units = inScopeCardUnits(state);
    if (units.length === 0) return false;
    const next: NumRole = units.every((u) => u.node.attrs['numRole'] === role) ? 'none' : role;
    if (dispatch) {
      const tr = state.tr;
      // Attr-only edits don't shift positions, so no remapping is needed.
      for (const u of units) tr.setNodeAttribute(u.pos, 'numRole', next);
      dispatch(tr);
      ensureNumberingVisible();
    }
    return true;
  };
}

/** Toggle the "number" role on the in-scope card set. */
export const toggleNumberRole = makeRoleToggle('number');
/** Toggle the "substructure" role on the in-scope card set. */
export const toggleSubRole = makeRoleToggle('sub');

/**
 * Flip the restart flag ("start the count over here") on the cursor's unit — its
 * enclosing block header, or its card/analytic_unit. On a block this toggles
 * restart(default)↔continue; on a card it toggles a mid-list restart on/off.
 */
export const toggleNumRestart: Command = (state, dispatch) => {
  const $pos = state.selection.$from;
  let target: CardUnit | null = null;
  for (let d = $pos.depth; d >= 0; d--) {
    const n = $pos.node(d);
    const t = n.type.name;
    if (t === 'block' || t === 'card' || t === 'analytic_unit') {
      target = { pos: $pos.before(d), node: n };
      break;
    }
  }
  if (!target) return false;
  if (dispatch) {
    dispatch(state.tr.setNodeAttribute(target.pos, 'numRestart', !target.node.attrs['numRestart']));
    ensureNumberingVisible();
  }
  return true;
};

/**
 * The current numbering state at the selection, for the ribbon buttons'
 * pressed indicators. `number`/`sub` are true when EVERY in-scope card carries
 * that role (the same set `makeRoleToggle` acts on); `restart` mirrors
 * `toggleNumRestart`'s target — the cursor's enclosing block (which restarts by
 * default, so it's "on" unless flagged continue) or card/analytic (on only when
 * explicitly flagged to restart).
 */
export function numberingSelectionState(
  state: EditorState,
  precomputedUnits?: CardUnit[],
): {
  number: boolean;
  sub: boolean;
  restart: boolean;
} {
  // The fused selection-chrome walk (selection-chrome.ts) already collected
  // the in-scope units for range selections; accept them to avoid a second
  // O(selection) walk per refresh. Semantics identical to inScopeCardUnits.
  const units = precomputedUnits ?? inScopeCardUnits(state);
  const allRole = (role: NumRole): boolean =>
    units.length > 0 && units.every((u) => u.node.attrs['numRole'] === role);
  const $pos = state.selection.$from;
  let restart = false;
  for (let d = $pos.depth; d >= 0; d--) {
    const n = $pos.node(d);
    const t = n.type.name;
    if (t === 'block') {
      restart = n.attrs['numRestart'] !== false;
      break;
    }
    if (t === 'card' || t === 'analytic_unit') {
      restart = n.attrs['numRestart'] === true;
      break;
    }
  }
  return { number: allRole('number'), sub: allRole('sub'), restart };
}
