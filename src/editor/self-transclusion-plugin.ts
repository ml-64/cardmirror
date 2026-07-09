/**
 * Live re-render for `self_ref` windows.
 *
 * A window's NodeView projects the source section resolved from the CURRENT doc,
 * but `NodeView.update` only fires when the node itself or its decorations
 * change — not when some *other* part of the doc (the source section) is edited.
 * This plugin bridges that: on every doc change it hashes each window's resolved
 * projection and stamps it as a node decoration (`data-src-hash`). When a source
 * edit changes that hash, the decoration's attrs change, so ProseMirror calls
 * the NodeView's `update`, which re-resolves and re-renders. When nothing the
 * window mirrors changed, the hash is identical and no update fires — so
 * unrelated edits cost one hash, not a re-render.
 *
 * No document mutation, no history, no dirty flag — decorations only.
 */

import { Plugin, PluginKey, NodeSelection, TextSelection } from 'prosemirror-state';
import { Decoration, DecorationSet, type EditorView } from 'prosemirror-view';
import type { Node as PMNode } from 'prosemirror-model';
import { contentHash } from './transclusion.js';
import { isSelfRef, makeProjectionResolver } from './self-transclusion.js';

// ---- Mouse selection ACROSS a live view -----------------------------------
// A live view's projection is a non-editable island, so a NATIVE drag / shift-
// click selection stops at its boundary — the browser can't extend a selection
// across it. We can't override the selection MID-drag (the browser re-resets it
// every mousemove → flicker), so we let native selection run and, once the
// gesture ENDS, fix the range up to span any view it crossed. `anchor` is the
// gesture's start (drag origin, or the existing anchor for a shift-click);
// `head` is where it ended.

/** Whether a live view lies within [a, b] — the trigger to fix the range up. */
function rangeCrossesSelfRef(doc: PMNode, a: number, b: number): boolean {
  const from = Math.min(a, b);
  const to = Math.max(a, b);
  if (from >= to) return false;
  let found = false;
  doc.nodesBetween(from, to, (node) => {
    if (isSelfRef(node)) found = true;
    return !found;
  });
  return found;
}

/** Set an exact anchor→head TextSelection (spans a view `between` would clamp
 *  off). Deferred past the gesture so ProseMirror's own selection sync (which
 *  reads the native selection that stopped at the view) doesn't overwrite it. */
function spanSelectionAcrossView(view: EditorView, anchor: number, head: number): void {
  if ((view as unknown as { docView: unknown }).docView == null) return; // torn down
  const size = view.state.doc.content.size;
  if (anchor > size || head > size) return;
  try {
    const sel = TextSelection.create(view.state.doc, anchor, head);
    if (!view.state.selection.eq(sel)) view.dispatch(view.state.tr.setSelection(sel));
  } catch {
    /* endpoints not selectable — leave the native selection as-is */
  }
}

/** The in-flight mouse gesture's origin (module-level: only one at a time). */
let mouseGesture: { view: EditorView; anchor: number } | null = null;

export const selfRefPluginKey = new PluginKey<DecorationSet>('selfRefLiveRender');

function buildDecorations(doc: PMNode): DecorationSet {
  const decos: Decoration[] = [];
  // One resolver shared across every window (memoized — chained views resolve
  // once total, not once per window).
  const resolveProjection = makeProjectionResolver(doc);
  doc.descendants((node, pos) => {
    if (!isSelfRef(node)) return true;
    const p = resolveProjection(String(node.attrs['source_heading_id'] ?? ''));
    // The hash folds in the resolved content plus the missing/cycle state, so any
    // change the window should reflect flips it.
    const hash = `${p.missing ? 'M' : ''}${p.cycle ? 'C' : ''}:${contentHash(p.content)}`;
    decos.push(Decoration.node(pos, pos + node.nodeSize, { 'data-src-hash': hash }));
    return false; // atom — nothing to descend into
  });
  return DecorationSet.create(doc, decos);
}

export function makeSelfRefPlugin(): Plugin<DecorationSet> {
  return new Plugin<DecorationSet>({
    key: selfRefPluginKey,
    state: {
      init: (_config, state) => buildDecorations(state.doc),
      apply: (tr, value, _old, newState) =>
        tr.docChanged ? buildDecorations(newState.doc) : value,
    },
    props: {
      decorations(state) {
        const base = selfRefPluginKey.getState(state) ?? DecorationSet.empty;
        // A live view is an atom whose read-only projection is `user-select:none`,
        // so a text selection SPANNING it wouldn't paint any ::selection over it —
        // it'd look skipped. Mark every self_ref the current selection fully covers
        // so CSS can show it selected (so click-drag / shift-click across it, and
        // select→send-to-speech, visibly include the view). `nodesBetween` bounds
        // the scan to the selection, not the whole doc.
        const sel = state.selection;
        if (sel.empty) return base;
        const extra: Decoration[] = [];
        state.doc.nodesBetween(sel.from, sel.to, (node, pos) => {
          if (!isSelfRef(node)) return true;
          if (sel.from <= pos && sel.to >= pos + node.nodeSize) {
            extra.push(Decoration.node(pos, pos + node.nodeSize, { class: 'pmd-self-ref-in-selection' }));
          }
          return false; // atom — nothing to descend into
        });
        return extra.length ? base.add(state.doc, extra) : base;
      },
      // A plain click on a live view selects the WHOLE node (the green box) —
      // reliably, and consistently across instances. Without this, a click on some
      // views (e.g. two adjacent identical ones) starts a native word-selection in
      // the read-only projection instead of node-selecting. MODIFIED clicks are
      // left to native behavior: a shift-click must still EXTEND a text selection
      // to include the view (the click-above → shift-click-below gesture that
      // select→send-to-speech relies on), and the view stays span-selectable.
      handleClickOn(view, _pos, node, nodePos, event) {
        if (!isSelfRef(node)) return false;
        const e = event as MouseEvent;
        if (e.shiftKey || e.metaKey || e.ctrlKey || e.altKey || e.button !== 0) return false;
        view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, nodePos)));
        return true;
      },
      handleDOMEvents: {
        // Record the gesture's origin. A shift-click extends from the CURRENT
        // anchor; a fresh press starts at the pressed position. Never preventing
        // default — native selection runs; we only fix it up on release.
        mousedown(view, event) {
          const e = event as MouseEvent;
          if (e.button !== 0 || e.metaKey || e.ctrlKey || e.altKey) {
            mouseGesture = null;
            return false;
          }
          const anchor = e.shiftKey
            ? view.state.selection.anchor
            : (view.posAtCoords({ left: e.clientX, top: e.clientY })?.pos ?? null);
          mouseGesture = anchor == null ? null : { view, anchor };
          return false;
        },
        mouseup(view, event) {
          const g = mouseGesture;
          mouseGesture = null;
          if (!g || g.view !== view) return false;
          const e = event as MouseEvent;
          const head = view.posAtCoords({ left: e.clientX, top: e.clientY })?.pos;
          if (head == null || head === g.anchor) return false;
          if (!rangeCrossesSelfRef(view.state.doc, g.anchor, head)) return false;
          // The drag / shift-click crossed a live view (native selection stopped at
          // it). Defer so this lands AFTER ProseMirror finalizes the native
          // selection, then span the view.
          const { anchor } = g;
          setTimeout(() => spanSelectionAcrossView(view, anchor, head), 0);
          return false;
        },
      },
    },
  });
}
