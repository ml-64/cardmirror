/**
 * Read-mode decoration plugin.
 *
 * Tags each text node with one of two CSS classes:
 *   - `pmd-rm-keep`  — read-aloud content; visible in read mode
 *   - `pmd-rm-hide`  — non-read-aloud filler; hidden in read mode
 *
 * The decision is made per text node based on its parent paragraph and
 * its marks:
 *   - In `cite_paragraph`: keep iff carrying `cite_mark`.
 *   - In `card_body` / `paragraph` / `undertag`: keep iff carrying `highlight`.
 *   - Elsewhere (heading paragraphs etc.): no decoration — block-level
 *     CSS handles whether they show.
 *
 * The decorations are emitted only when read mode is *active*; with
 * read mode off there's nothing to render and we keep an empty set.
 * Toggling the setting fires a meta-flagged no-op transaction
 * (`PMD_READ_MODE_TOGGLE`) so the plugin can rebuild the set on
 * demand.
 *
 * Doc edits trigger an *incremental* update: existing decorations get
 * mapped through the transaction (positions adjust), then decorations
 * inside the touched region (expanded to top-level container) are
 * recomputed. This is O(touched-region) instead of O(whole-doc) per
 * keystroke — the dominant typing-latency win for large docs.
 *
 * Why the plugin instead of pure CSS: marks nest in the rendered DOM
 * (a highlight inside an underline ends up inside the underline's
 * span). Targeting "non-read-aloud text" via CSS specificity races
 * against the nested wrapper structure; tagging text nodes directly
 * with a per-node class avoids that entirely.
 */

import { Plugin } from 'prosemirror-state';
import { Decoration, DecorationSet } from 'prosemirror-view';
import type { Node as PMNode } from 'prosemirror-model';
import { settings } from './settings.js';
import { changedRange, expandToTopLevel } from './decoration-range.js';

/** Meta key used to force a recompute when read mode toggles. */
export const PMD_READ_MODE_TOGGLE = 'pmdReadModeToggle';

export const readModePlugin: Plugin<DecorationSet> = new Plugin<DecorationSet>({
  state: {
    init(_, { doc }) {
      return settings.get('readMode') ? computeFullSet(doc) : DecorationSet.empty;
    },
    apply(tr, prev, _oldState, newState) {
      if (tr.getMeta(PMD_READ_MODE_TOGGLE)) {
        return settings.get('readMode') ? computeFullSet(newState.doc) : DecorationSet.empty;
      }
      if (!tr.docChanged) return prev;
      // When read mode is off the decoration set is empty and stays
      // empty — skip the walk entirely.
      if (!settings.get('readMode')) return prev;

      const range = changedRange(tr);
      if (!range) return prev.map(tr.mapping, tr.doc);

      // Map existing decorations through the change, then replace any
      // that fall inside the recompute window.
      const expanded = expandToTopLevel(tr.doc, range.from, range.to);
      const mapped = prev.map(tr.mapping, tr.doc);
      const stale = mapped.find(expanded.from, expanded.to);
      const fresh = computeDecorationsInRange(tr.doc, expanded.from, expanded.to);
      return mapped.remove(stale).add(tr.doc, fresh);
    },
  },
  props: {
    decorations(state) {
      return readModePlugin.getState(state);
    },
  },
});

function computeFullSet(doc: PMNode): DecorationSet {
  return DecorationSet.create(doc, computeDecorationsInRange(doc, 0, doc.content.size));
}

/**
 * Build the decoration list for text nodes whose start position lies
 * within [from, to]. Callers pass a `from`/`to` already expanded to
 * top-level container boundaries so partial paragraphs aren't
 * visited mid-traversal.
 *
 * Two-pass per paragraph: for each kept text node we look at the
 * *next* text child. End-of-run (next node is hidden, or no next
 * node) gets a widget-decoration separator inserted AT the
 * boundary. The widget renders outside any mark wrappers — a plain
 * `<span>` containing a space — so the separator inherits no
 * emphasis box / highlight background. Mid-run kept spans (e.g.
 * a single highlighted phrase split into pieces by a bold sub-mark)
 * get no separator, so the highlight band reads continuously.
 */
function computeDecorationsInRange(doc: PMNode, from: number, to: number): Decoration[] {
  const decos: Decoration[] = [];
  doc.nodesBetween(from, to, (node, pos) => {
    const name = node.type.name;
    let markName: string | null = null;
    if (name === 'cite_paragraph') markName = 'cite_mark';
    else if (name === 'card_body' || name === 'paragraph' || name === 'undertag') {
      markName = 'highlight';
    }
    if (markName) {
      decorateParagraph(node, pos, markName, decos);
      // We've already walked this paragraph's inline children; don't
      // recurse into them again from the outer nodesBetween.
      return false;
    }
    return true;
  });
  return decos;
}

/** Build the separator widget's DOM. A bare `<span>` containing a
 *  single space character. Lives as a sibling of the mark wrappers
 *  rather than a child, so emphasis boxes / highlight backgrounds
 *  don't bleed into the gap. */
function makeRunSeparator(): HTMLElement {
  const span = document.createElement('span');
  span.className = 'pmd-rm-separator';
  span.textContent = ' ';
  // Widgets are inherently non-editable in PM; the explicit attr
  // here is belt-and-suspenders against any DOM mutation paths
  // that might otherwise try to step inside it.
  span.contentEditable = 'false';
  return span;
}

/** Walk one paragraph's direct text children in order. For each
 *  kept text node, decide whether it ends a run; if so, emit a
 *  widget separator at the boundary. */
function decorateParagraph(
  para: PMNode,
  paraPos: number,
  markName: string,
  decos: Decoration[],
): void {
  interface Item { pos: number; nodeSize: number; keep: boolean }
  const items: Item[] = [];
  para.forEach((child, offset) => {
    if (!child.isText || !child.text) return;
    const keep = child.marks.some((m) => m.type.name === markName);
    items.push({ pos: paraPos + 1 + offset, nodeSize: child.nodeSize, keep });
  });
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    if (item.keep) {
      decos.push(
        Decoration.inline(item.pos, item.pos + item.nodeSize, {
          class: 'pmd-rm-keep',
        }),
      );
      // End-of-run boundary: drop a sibling-level separator widget
      // at the position where the next inline content begins.
      const next = items[i + 1];
      const endsRun = !next || !next.keep;
      if (endsRun) {
        decos.push(
          Decoration.widget(item.pos + item.nodeSize, makeRunSeparator, {
            side: 1,
            ignoreSelection: true,
          }),
        );
      }
    } else {
      decos.push(
        Decoration.inline(item.pos, item.pos + item.nodeSize, {
          class: 'pmd-rm-hide',
        }),
      );
    }
  }
}
