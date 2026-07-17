import { describe, expect, it } from 'vitest';
import { schema, newHeadingId } from '../../src/schema/index.js';
import type { Node as PMNode } from 'prosemirror-model';

/**
 * Cards render with a per-card `contain-intrinsic-height` estimate so
 * content-visibility placeholder boxes approximate real heights.
 * Regression test for the nav-jump layout-churn freeze: with the old
 * flat 200px placeholder, jumps into unvisited regions of a large doc
 * triggered seconds of correction layout (see intrinsicHeightStyle in
 * src/schema/nodes.ts).
 */

function makeCard(paraCount: number, paraText: string): PMNode {
  const tag = schema.nodes['tag']!.create({ id: newHeadingId() }, schema.text('Tag'));
  const bodies = Array.from({ length: paraCount }, () =>
    schema.nodes['card_body']!.create(null, paraText ? schema.text(paraText) : null),
  );
  return schema.nodes['card']!.createChecked(null, [tag, ...bodies]);
}

function styleOf(node: PMNode): string {
  const spec = node.type.spec.toDOM!(node) as [string, Record<string, string>, number];
  return spec[1]['style'] ?? '';
}

function estimateOf(node: PMNode): number {
  const m = styleOf(node).match(/contain-intrinsic-height: auto (\d+)px/);
  expect(m, `card toDOM should carry an intrinsic-height estimate, got: "${styleOf(node)}"`).toBeTruthy();
  return Number(m![1]);
}

describe('card intrinsic-height estimate', () => {
  it('card toDOM emits a contain-intrinsic-height estimate', () => {
    expect(estimateOf(makeCard(1, 'short'))).toBeGreaterThanOrEqual(40);
  });

  it('analytic_unit toDOM emits one too', () => {
    const analytic = schema.nodes['analytic']!.create({ id: newHeadingId() }, schema.text('Analytic'));
    const body = schema.nodes['card_body']!.create(null, schema.text('body text'));
    const unit = schema.nodes['analytic_unit']!.createChecked(null, [analytic, body]);
    expect(styleOf(unit)).toMatch(/contain-intrinsic-height: auto \d+px/);
  });

  it('scales with content: a long card estimates much taller than a short one', () => {
    const short = estimateOf(makeCard(1, 'one line of text'));
    const long = estimateOf(makeCard(15, 'a full paragraph of card body text that wraps across several rendered lines when laid out at the default editor width and font size'));
    expect(long).toBeGreaterThan(short * 3);
  });

  it('never goes below the single-line floor', () => {
    expect(estimateOf(makeCard(1, ''))).toBeGreaterThanOrEqual(40);
  });

  it('round-trips through parseDOM without picking up the style as an attr', () => {
    // The inline style is presentation-only; parsing our own HTML back
    // must not create attribute churn.
    const card = makeCard(2, 'body');
    const attrs = (card.type.spec.toDOM!(card) as [string, Record<string, string>, number])[1];
    expect(Object.keys(attrs).sort()).toEqual(['class', 'style']);
  });
});
