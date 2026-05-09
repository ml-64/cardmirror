/**
 * Card-body absorption plugin.
 *
 * Enforces the editing-semantics rule (ARCHITECTURE.md §14.3): a
 * `paragraph` at doc level whose previous sibling is a `card` or
 * `analytic_unit` is auto-absorbed as a `card_body` appended to that
 * container's content. To bound a region of loose paragraphs after a
 * card, the user inserts a heading (Pocket / Hat / Block) — anything
 * non-paragraph, non-card breaks the absorption zone.
 *
 * Cases preserved (no absorption):
 *   - Block / Hat / Pocket → paragraph → tag        (legitimate bridge text)
 *   - Doc start → paragraph → anything              (top-of-doc preface)
 *   - Heading → paragraph → heading                  (between sections)
 *
 * Why an appendTransaction plugin and not a schema constraint:
 * ProseMirror content expressions are context-free, so they can't say
 * "paragraph is illegal here only when the previous sibling is a card."
 * Absorption runs after every doc-changing transaction; it walks the
 * doc-level children once and rebuilds any cards / analytic_units that
 * need to grow.
 */

import { Plugin } from 'prosemirror-state';
import { Fragment, type Node as PMNode } from 'prosemirror-model';
import { schema } from '../schema/index.js';

const ABSORBING_TYPES = new Set(['card', 'analytic_unit']);

export const absorbPlugin: Plugin = new Plugin({
  appendTransaction(transactions, _oldState, newState) {
    if (!transactions.some((t) => t.docChanged)) return null;

    const rebuilt = absorbedDocChildren(newState.doc);
    if (!rebuilt) return null;

    return newState.tr.replaceWith(0, newState.doc.content.size, rebuilt);
  },
});

/**
 * Walk the doc's top-level children and produce a new Fragment with
 * loose paragraphs absorbed into preceding card / analytic_unit
 * siblings. Returns `null` if no changes were necessary, so callers can
 * skip dispatching a no-op transaction.
 */
export function absorbedDocChildren(doc: PMNode): Fragment | null {
  const out: PMNode[] = [];
  let absorbing: PMNode | null = null;
  let absorbedParagraphs: PMNode[] = [];
  let modified = false;

  function flush(): void {
    if (absorbing === null) return;
    if (absorbedParagraphs.length === 0) {
      out.push(absorbing);
    } else {
      const cardBodies = absorbedParagraphs.map((p) =>
        schema.nodes['card_body']!.create(null, p.content),
      );
      const merged = absorbing.copy(
        absorbing.content.append(Fragment.fromArray(cardBodies)),
      );
      out.push(merged);
      modified = true;
    }
    absorbing = null;
    absorbedParagraphs = [];
  }

  doc.forEach((child) => {
    const t = child.type.name;
    if (ABSORBING_TYPES.has(t)) {
      flush();
      absorbing = child;
    } else if (t === 'paragraph' && absorbing !== null) {
      absorbedParagraphs.push(child);
    } else {
      flush();
      out.push(child);
    }
  });
  flush();

  if (!modified) return null;
  return Fragment.fromArray(out);
}
