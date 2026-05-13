/**
 * Similar-selection plugin — a "shadow selection" the user can light
 * up via the Select Similar commands. Holds:
 *
 *   - `matches`: doc-position ranges that share the fingerprint of
 *     the run the cursor was on when the command ran. Rendered with
 *     `.pmd-similar-match` (dashed outline).
 *   - `scope`: an outer range (used by the scoped flow) the matching
 *     is restricted to. Rendered with `.pmd-similar-scope` (faint
 *     background tint).
 *   - `mode`: `'idle'` or `'awaiting-cursor'`. The scoped flow enters
 *     `awaiting-cursor` after the scope is set; the next collapsed-
 *     selection transaction inside the scope triggers matching.
 *
 * The fingerprint is (parent textblock type name, full mark set of
 * the text node the cursor is on). A run matches iff parent block
 * type is identical AND the mark sets are equal (same Mark types,
 * same attrs). A plain run with no marks matches only other plain
 * runs of the same parent type — so cursor-on-card_body-with-no-
 * direct-formatting selects all such body runs, not every card_body
 * in the doc.
 *
 * Dismissal: any doc change clears everything. Selection-change
 * clears unless the new collapsed cursor lands inside a match (which
 * is what happens after the command's own dispatch, so it doesn't
 * dissipate itself). Escape clears via `handleKeyDown`.
 *
 * No format command consumes the shadow selection yet — first cut
 * is pure decoration. See DECISIONS for the deferred work.
 */

import { Plugin, PluginKey, type EditorState, type Command } from 'prosemirror-state';
import { Decoration, DecorationSet } from 'prosemirror-view';
import type { Node as PMNode, Mark } from 'prosemirror-model';

export interface RangePair {
  from: number;
  to: number;
}

export interface SimilarSelectionState {
  matches: RangePair[];
  scope: RangePair | null;
  mode: 'idle' | 'awaiting-cursor';
}

const META_KEY = 'pmd-similar-selection';

type Meta =
  | { type: 'setMatches'; matches: RangePair[] }
  | { type: 'setScope'; scope: RangePair }
  | { type: 'clear' };

export const similarSelectionKey = new PluginKey<SimilarSelectionState>(
  'similar-selection',
);

/**
 * Build the plugin. The factory takes the chip's effective-pt
 * resolver so the matching the plugin does internally (scoped
 * flow's `awaiting-cursor` → trigger transition) uses the same
 * size logic the standalone commands use. Defaulting the param to
 * a "raw font_size mark only" resolver keeps simple test cases
 * easy to construct.
 */
export function buildSimilarSelectionPlugin(
  effectivePt: EffectivePtResolver = defaultEffectivePt,
): Plugin<SimilarSelectionState> {
  return new Plugin<SimilarSelectionState>({
    key: similarSelectionKey,
    state: {
      init: () => ({ matches: [], scope: null, mode: 'idle' }),
      apply(tr, prev): SimilarSelectionState {
        const meta = tr.getMeta(META_KEY) as Meta | undefined;

        if (meta?.type === 'clear') {
          return { matches: [], scope: null, mode: 'idle' };
        }
        if (meta?.type === 'setScope') {
          return { matches: [], scope: meta.scope, mode: 'awaiting-cursor' };
        }
        if (meta?.type === 'setMatches') {
          return { matches: meta.matches, scope: null, mode: 'idle' };
        }

        // Any doc edit dissipates the shadow selection.
        if (tr.docChanged) {
          if (prev.matches.length > 0 || prev.scope) {
            return { matches: [], scope: null, mode: 'idle' };
          }
          return prev;
        }

        if (tr.selectionSet) {
          // Scoped flow: the next collapsed-cursor inside the scope
          // triggers matching. A cursor outside cancels.
          if (prev.mode === 'awaiting-cursor' && prev.scope) {
            const sel = tr.selection;
            if (sel.empty) {
              const pos = sel.from;
              if (pos < prev.scope.from || pos > prev.scope.to) {
                return { matches: [], scope: null, mode: 'idle' };
              }
              const matches = computeSimilarMatches(
                tr.doc,
                pos,
                prev.scope,
                effectivePt,
              );
              return { matches, scope: prev.scope, mode: 'idle' };
            }
            // User may still be reshaping their scope-internal selection.
            return prev;
          }

          // Matches were active and selection moved: clear unless the
          // new cursor landed inside an existing match. (The command's
          // own setMatches tr is handled above via meta and won't reach
          // this branch.)
          if (prev.matches.length > 0) {
            const sel = tr.selection;
            const insideMatch =
              sel.empty &&
              prev.matches.some((m) => sel.from >= m.from && sel.from <= m.to);
            if (!insideMatch) {
              return { matches: [], scope: null, mode: 'idle' };
            }
          }
        }

        return prev;
      },
    },
    props: {
      decorations(state) {
        const ps = similarSelectionKey.getState(state);
        if (!ps) return null;
        const decs: Decoration[] = [];
        if (ps.scope) {
          decs.push(
            Decoration.inline(ps.scope.from, ps.scope.to, {
              class: 'pmd-similar-scope',
            }),
          );
        }
        for (const m of ps.matches) {
          decs.push(
            Decoration.inline(m.from, m.to, { class: 'pmd-similar-match' }),
          );
        }
        if (decs.length === 0) return null;
        return DecorationSet.create(state.doc, decs);
      },
      handleKeyDown(view, e) {
        if (e.key !== 'Escape') return false;
        const ps = similarSelectionKey.getState(view.state);
        if (!ps) return false;
        if (
          ps.matches.length === 0 &&
          !ps.scope &&
          ps.mode === 'idle'
        ) {
          return false;
        }
        view.dispatch(view.state.tr.setMeta(META_KEY, { type: 'clear' }));
        return true;
      },
    },
  });
}

/** Naive fallback: reads `font_size` marks; falls through to 11. */
function defaultEffectivePt(node: PMNode | null, _parent: PMNode): number {
  if (!node || !node.isText) return 11;
  const fs = node.marks.find((m) => m.type.name === 'font_size');
  if (fs) return Number(fs.attrs['halfPoints'] ?? 22) / 2;
  return 11;
}

/** Resolver for a run's effective font-size in pt. Same shape as
 *  `RibbonContext.effectivePtForNode` — the real editor passes the
 *  chip resolver here so two runs with the *same visual* size match
 *  even when one has an explicit `font_size` mark and the other
 *  inherits from its named-style or paragraph default. */
export type EffectivePtResolver = (
  node: PMNode | null,
  parent: PMNode,
) => number;

/** Marks of the text node "at" `pos`, the parent block type, AND the
 *  chip-resolved effective font-size. Preference order for the node:
 *  the run immediately before the cursor (Word's typing-continues-
 *  previous-run convention), then the run after. Returns null when
 *  there's no surrounding text. */
function fingerprintAt(
  doc: PMNode,
  pos: number,
  effectivePt: EffectivePtResolver,
): {
  parentTypeName: string;
  marks: readonly Mark[];
  effectivePt: number;
} | null {
  const $pos = doc.resolve(pos);
  const parent = $pos.parent;
  if (!parent.isTextblock) return null;
  const before = $pos.nodeBefore;
  const after = $pos.nodeAfter;
  const node =
    before && before.isText
      ? before
      : after && after.isText
      ? after
      : null;
  if (!node) return null;
  return {
    parentTypeName: parent.type.name,
    // Drop `font_size` from the comparable mark set — the effective
    // pt below covers it. Otherwise an explicit `font_size: 22` run
    // wouldn't match a bare run inheriting 11 from its named style
    // even when both display at 11 in the chip.
    marks: stripFontSize(node.marks),
    effectivePt: effectivePt(node, parent),
  };
}

function stripFontSize(marks: readonly Mark[]): readonly Mark[] {
  if (marks.length === 0) return marks;
  let any = false;
  for (const m of marks) {
    if (m.type.name === 'font_size') {
      any = true;
      break;
    }
  }
  if (!any) return marks;
  return marks.filter((m) => m.type.name !== 'font_size');
}

function marksEqual(a: readonly Mark[], b: readonly Mark[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (!a[i]!.eq(b[i]!)) return false;
  }
  return true;
}

/** Walk `doc` (or just the `scope` range, if given) and return every
 *  text-node range whose fingerprint matches the one at `cursorPos`.
 *  The `effectivePt` resolver should be the chip's — so two runs with
 *  the same visible font-size match even when one has an explicit
 *  `font_size` mark and the other doesn't. */
export function computeSimilarMatches(
  doc: PMNode,
  cursorPos: number,
  scope: RangePair | null,
  effectivePt: EffectivePtResolver,
): RangePair[] {
  const fp = fingerprintAt(doc, cursorPos, effectivePt);
  if (!fp) return [];
  const from = scope?.from ?? 0;
  const to = scope?.to ?? doc.content.size;
  const out: RangePair[] = [];
  doc.nodesBetween(from, to, (node, pos, parent) => {
    if (!node.isText) return true;
    if (!parent || parent.type.name !== fp.parentTypeName) return true;
    if (!marksEqual(stripFontSize(node.marks), fp.marks)) return true;
    if (effectivePt(node, parent) !== fp.effectivePt) return true;
    const start = Math.max(from, pos);
    const end = Math.min(to, pos + node.nodeSize);
    if (start < end) out.push({ from: start, to: end });
    return true;
  });
  return out;
}

/** Unscoped Select Similar (Doc menu). No-op on a non-empty
 *  selection per the user spec; otherwise lights up every run in
 *  the doc whose fingerprint matches the cursor's. */
export function selectSimilar(effectivePt: EffectivePtResolver): Command {
  return (state, dispatch) => {
    if (!state.selection.empty) return false;
    const matches = computeSimilarMatches(
      state.doc,
      state.selection.from,
      null,
      effectivePt,
    );
    if (matches.length === 0) return false;
    if (!dispatch) return true;
    dispatch(
      state.tr.setMeta(META_KEY, { type: 'setMatches', matches } as Meta),
    );
    return true;
  };
}

/** Scoped Select Similar (Doc menu).
 *
 *  Two-stage flow:
 *
 *    1. First invocation requires a non-empty selection. That range
 *       becomes the scope; the plugin enters `awaiting-cursor` mode
 *       and renders a faint background tint around the scope.
 *    2. The next collapsed-cursor transaction handled by the plugin
 *       triggers matching: if the cursor lands inside the scope, all
 *       similar runs within the scope are highlighted; if outside,
 *       the scope is cancelled.
 *
 *  If invoked with an empty selection, the command no-ops (and the
 *  caller — menu / button — can surface "make a selection first"
 *  inline if it wants). The matching itself happens inside the plugin
 *  apply, which is wired up with the resolver via `wireSimilarSelection`. */
export function selectSimilarScoped(): Command {
  return (state, dispatch) => {
    const { from, to, empty } = state.selection;
    if (empty) return false;
    if (!dispatch) return true;
    dispatch(
      state.tr.setMeta(META_KEY, {
        type: 'setScope',
        scope: { from, to },
      } as Meta),
    );
    return true;
  };
}

/** Programmatically clear the shadow selection. Exposed so the
 *  keybinding editor / menu can offer a "Clear similar selection"
 *  action if desired later. */
export function clearSimilarSelection(): Command {
  return (state, dispatch) => {
    const ps = similarSelectionKey.getState(state);
    if (!ps) return false;
    if (ps.matches.length === 0 && !ps.scope && ps.mode === 'idle') {
      return false;
    }
    if (!dispatch) return true;
    dispatch(state.tr.setMeta(META_KEY, { type: 'clear' } as Meta));
    return true;
  };
}

/** Snapshot accessor for tests / UI introspection. */
export function getSimilarSelectionState(
  state: EditorState,
): SimilarSelectionState {
  return (
    similarSelectionKey.getState(state) ?? {
      matches: [],
      scope: null,
      mode: 'idle',
    }
  );
}
