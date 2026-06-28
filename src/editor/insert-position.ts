/**
 * Where a block-level insert should land so it never splits the card the
 * cursor happens to be in.
 *
 * Inserting a structural slice (a shelf card, a quick card, a sent slice) at a
 * raw caret inside a `card` forces ProseMirror to split the card to fit it,
 * which spawns a phantom blank-tag (`id: null`) card for the orphaned tail. The
 * insert paths instead snap to the nearest top-level boundary — exactly where a
 * drag-and-drop would drop the slice — so it lands as a clean sibling.
 */

import { type Node as PMNode } from 'prosemirror-model';

/**
 * The nearest top-level (doc-child) boundary to `pos`: the position just before
 * or just after the doc-level node containing `pos`, whichever is closer. When
 * `pos` is already at the doc root (between top-level nodes), it's returned
 * unchanged. Ties favor the boundary *before* the node.
 */
export function nearestTopLevelInsertPos(doc: PMNode, pos: number): number {
  const $pos = doc.resolve(pos);
  if ($pos.depth < 1) return pos; // already a doc-level gap
  const before = $pos.before(1);
  const after = $pos.after(1);
  return pos - before <= after - pos ? before : after;
}
