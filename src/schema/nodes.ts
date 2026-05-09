/**
 * ProseMirror node specs.
 *
 * Design choice (see DECISIONS.md):
 *
 *   Most heading-level nodes (pocket, hat, block, analytic) are *flat
 *   paragraphs with inline content*, not tree containers. This matches
 *   how Word represents them in OOXML (paragraphs with Heading1-3 /
 *   Analytic styles, hierarchy implicit in document order + outline
 *   level). Tree-shaped grouping ("the cards under hat 2") is a derived
 *   view — the navigation panel walks paragraphs grouped by outline
 *   level — not a schema constraint.
 *
 *   `card` *is* tree-structured: it has a required `tag` child, optional
 *   cite_paragraph or analytic, and zero+ card_body paragraphs. This
 *   matches the user's mental model of cards as objects we can move /
 *   send / drag / select as units.
 *
 *   Heading-like nodes (pocket, hat, block, tag, analytic) carry a
 *   stable `id` attribute (UUID) for transclusion targeting per
 *   ARCHITECTURE.md §4 and §12.
 */

import type { NodeSpec } from 'prosemirror-model';
import { newHeadingId } from './ids.js';

const headingAttrs = {
  id: {
    default: null as string | null,
    validate: (v: unknown) => (v === null || typeof v === 'string'),
  },
};

/** Generate a fresh ID at construction time if none provided. */
export function ensureId(attrs: Record<string, unknown> | null): { id: string } {
  if (attrs && typeof attrs['id'] === 'string' && attrs['id']) {
    return { id: attrs['id'] };
  }
  return { id: newHeadingId() };
}

/**
 * Block-level content legal at the doc root. Note: `tag` and `analytic`
 * are *not* in this list — tags only appear as the required first child
 * of a `card`, analytics only appear inside an `analytic_unit` (or as a
 * cite-position alternative inside a card).
 */
const BLOCK_CONTENT =
  '(pocket | hat | block | card | analytic_unit | paragraph | undertag | cite_paragraph | card_body)*';

export const nodes: { [name: string]: NodeSpec } = {
  /** Top-level container. Sequence of block-level content. */
  doc: { content: BLOCK_CONTENT },

  /** A run of inline content. Plain text + marks. */
  text: { group: 'inline' },

  /**
   * Heading paragraphs — flat in document order, hierarchy via the
   * derived outline view, not schema containment.
   */
  pocket: {
    content: 'inline*',
    attrs: headingAttrs,
    defining: true,
    parseDOM: [{ tag: 'h1.pmd-pocket' }],
    toDOM: (node) => [
      'h1',
      { class: 'pmd-pocket', 'data-id': node.attrs['id'] ?? '' },
      0,
    ],
  },

  hat: {
    content: 'inline*',
    attrs: headingAttrs,
    defining: true,
    parseDOM: [{ tag: 'h2.pmd-hat' }],
    toDOM: (node) => [
      'h2',
      { class: 'pmd-hat', 'data-id': node.attrs['id'] ?? '' },
      0,
    ],
  },

  block: {
    content: 'inline*',
    attrs: headingAttrs,
    defining: true,
    parseDOM: [{ tag: 'h3.pmd-block' }],
    toDOM: (node) => [
      'h3',
      { class: 'pmd-block', 'data-id': node.attrs['id'] ?? '' },
      0,
    ],
  },

  /**
   * A card: required tag, optional undertag(s) attached to the tag,
   * optional cite paragraph (or in-card analytic), zero or more body
   * paragraphs.
   *
   * Undertags belong to the tag they follow — they don't mark a card
   * boundary. This is enforced by including `undertag*` in the content
   * expression right after `tag`.
   */
  card: {
    content: 'tag undertag* (cite_paragraph | analytic)? card_body*',
    defining: true,
    isolating: true,
    parseDOM: [{ tag: 'div.pmd-card' }],
    toDOM: () => ['div', { class: 'pmd-card' }, 0],
  },

  /** Card label. Heading-level outline-4 with stable id. Card-only. */
  tag: {
    content: 'inline*',
    attrs: headingAttrs,
    defining: true,
    parseDOM: [{ tag: 'h4.pmd-tag' }],
    toDOM: (node) => [
      'h4',
      { class: 'pmd-tag', 'data-id': node.attrs['id'] ?? '' },
      0,
    ],
  },

  /** Cite paragraph. Used inside a card or at the doc level. */
  cite_paragraph: {
    content: 'inline*',
    parseDOM: [{ tag: 'p.pmd-cite-para' }],
    toDOM: () => ['p', { class: 'pmd-cite-para' }, 0],
  },

  /** Card body paragraph — implicit Normal style on export. */
  card_body: {
    content: 'inline*',
    parseDOM: [{ tag: 'p.pmd-card-body' }],
    toDOM: () => ['p', { class: 'pmd-card-body' }, 0],
  },

  /**
   * Analytic paragraph — outline-level-4 with stable id. Distinct from
   * a tag in styling (color #1F3864) and semantic role. Appears as the
   * required first child of an `analytic_unit`, OR as a cite-position
   * alternative inside a `card`.
   */
  analytic: {
    content: 'inline*',
    attrs: headingAttrs,
    defining: true,
    parseDOM: [{ tag: 'p.pmd-analytic' }],
    toDOM: (node) => [
      'p',
      { class: 'pmd-analytic', 'data-id': node.attrs['id'] ?? '' },
      0,
    ],
  },

  /**
   * An analytic-rooted unit, peer to `card`. Required analytic, optional
   * undertag(s), zero+ body paragraphs. Drags as a unit. Real usage is
   * typically just the analytic with no body, but the schema allows
   * multi-paragraph analytics for parity with cards.
   *
   * Note: no cite_paragraph slot — analytics are commentary, not
   * external evidence with a citation.
   */
  analytic_unit: {
    content: 'analytic undertag* card_body*',
    defining: true,
    isolating: true,
    parseDOM: [{ tag: 'div.pmd-analytic-unit' }],
    toDOM: () => ['div', { class: 'pmd-analytic-unit' }, 0],
  },

  /** Undertag paragraph (linked to UndertagChar). */
  undertag: {
    content: 'inline*',
    parseDOM: [{ tag: 'p.pmd-undertag' }],
    toDOM: () => ['p', { class: 'pmd-undertag' }, 0],
  },

  /** Generic body paragraph — implicit Normal style. */
  paragraph: {
    content: 'inline*',
    parseDOM: [{ tag: 'p' }],
    toDOM: () => ['p', 0],
  },
};
