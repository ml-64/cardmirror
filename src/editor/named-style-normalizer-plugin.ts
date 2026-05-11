/**
 * Named-style normalizer plugin.
 *
 * Enforces the invariant that underline representation tracks the
 * containing textblock's role:
 *
 *   - Body-like textblocks (`paragraph`, `card_body`, `cite_paragraph`)
 *     → use `underline_mark` (the named "Underline" character style).
 *     `underline_direct` here would mean direct-formatting underline
 *     in a body, which collides with Verbatim's StyleUnderline
 *     convention. We auto-promote.
 *
 *   - Structural textblocks (`tag`, `analytic`, `pocket`, `hat`,
 *     `block`, `undertag`) → use `underline_direct`. `underline_mark`
 *     here would semantically misclassify the heading as "underlined
 *     evidence." We auto-demote.
 *
 * The two marks render visually identical (both produce an underline);
 * the difference is round-trip: `underline_mark` exports as `rStyle=
 * "StyleUnderline"` + direct `<w:u/>`, while `underline_direct`
 * exports as just `<w:u/>` with no rStyle.
 *
 * The flip is unconditional on every transaction — paste, import via
 * editor edits, and any future command that creates these marks all
 * end up in the canonical state without each path needing its own
 * policy logic.
 */

import { Plugin } from 'prosemirror-state';
import type { Transaction } from 'prosemirror-state';
import { Fragment, type Node as PMNode } from 'prosemirror-model';
import { schema } from '../schema/index.js';

const BODY_TEXTBLOCKS = new Set<string>(['paragraph', 'card_body', 'cite_paragraph']);
const STRUCTURAL_TEXTBLOCKS = new Set<string>([
  'tag', 'analytic', 'pocket', 'hat', 'block', 'undertag',
]);

export const namedStyleNormalizerPlugin: Plugin = new Plugin({
  appendTransaction(transactions, _oldState, newState) {
    if (!transactions.some((t) => t.docChanged)) return null;

    const directMark = schema.marks['underline_direct']!;
    const namedMark = schema.marks['underline_mark']!;
    let tr: Transaction | null = null;

    newState.doc.descendants((node, pos, parent) => {
      if (!node.isText || !parent) return true;
      const parentName = parent.type.name;
      const hasDirect = node.marks.some((m) => m.type === directMark);
      const hasNamed = node.marks.some((m) => m.type === namedMark);
      if (BODY_TEXTBLOCKS.has(parentName) && hasDirect) {
        if (!tr) tr = newState.tr;
        tr.removeMark(pos, pos + node.nodeSize, directMark);
        if (!hasNamed) tr.addMark(pos, pos + node.nodeSize, namedMark.create());
      } else if (STRUCTURAL_TEXTBLOCKS.has(parentName) && hasNamed) {
        if (!tr) tr = newState.tr;
        tr.removeMark(pos, pos + node.nodeSize, namedMark);
        if (!hasDirect) tr.addMark(pos, pos + node.nodeSize, directMark.create());
      }
      return true;
    });

    return tr;
  },
});

export function isBodyTextblock(node: PMNode): boolean {
  return BODY_TEXTBLOCKS.has(node.type.name);
}

export function isStructuralTextblock(node: PMNode): boolean {
  return STRUCTURAL_TEXTBLOCKS.has(node.type.name);
}

/**
 * Apply the same body-vs-structural underline rule to a static doc
 * tree (no transactions involved). Used by the importer so freshly-
 * loaded docs are already in the canonical form before the editor's
 * first dispatch.
 */
export function normalizeUnderlineMarks(doc: PMNode): PMNode {
  const namedMark = schema.marks['underline_mark']!;
  const directMark = schema.marks['underline_direct']!;

  function walk(node: PMNode): PMNode {
    if (node.isText) return node;
    if (node.isTextblock) {
      const name = node.type.name;
      const isBody = BODY_TEXTBLOCKS.has(name);
      const isStructural = STRUCTURAL_TEXTBLOCKS.has(name);
      if (!isBody && !isStructural) return node;
      const children: PMNode[] = [];
      let changed = false;
      node.forEach((child) => {
        if (!child.isText) {
          children.push(child);
          return;
        }
        let marks = child.marks;
        const hasDirect = marks.some((m) => m.type === directMark);
        const hasNamed = marks.some((m) => m.type === namedMark);
        if (isBody && hasDirect) {
          marks = marks.filter((m) => m.type !== directMark);
          if (!hasNamed) marks = namedMark.create().addToSet(marks);
          changed = true;
        } else if (isStructural && hasNamed) {
          marks = marks.filter((m) => m.type !== namedMark);
          if (!hasDirect) marks = directMark.create().addToSet(marks);
          changed = true;
        }
        children.push(marks === child.marks ? child : child.mark(marks));
      });
      return changed ? node.copy(Fragment.fromArray(children)) : node;
    }
    // Container — recurse.
    const children: PMNode[] = [];
    let changed = false;
    node.forEach((child) => {
      const next = walk(child);
      if (next !== child) changed = true;
      children.push(next);
    });
    return changed ? node.copy(Fragment.fromArray(children)) : node;
  }

  return walk(doc);
}
