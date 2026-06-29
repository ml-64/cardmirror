// @vitest-environment jsdom

/**
 * Caret-tracking stays on the current heading while typing on the line just
 * above the next one. The nav pane caches each heading's doc position at render
 * time and rebuilds on a ~200ms debounce; `remapPositions` maps those cached
 * positions forward through each edit so the synchronous `setCaretHeading` never
 * compares a post-edit caret against pre-edit positions (which briefly lit the
 * next heading — the flicker).
 */

import { describe, expect, it } from 'vitest';
import { EditorState } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { schema, newHeadingId } from '../../src/schema/index.js';
import type { Node as PMNode } from 'prosemirror-model';
import { NavigationPanel } from '../../src/editor/nav-panel.js';

function makeDocAndView() {
  const t1 = newHeadingId();
  const t2 = newHeadingId();
  const doc = schema.nodes['doc']!.create(null, [
    schema.nodes['card']!.create(null, [
      schema.nodes['tag']!.create({ id: t1 }, schema.text('First')),
      schema.nodes['card_body']!.create(null, schema.text('body')),
    ]),
    schema.nodes['card']!.create(null, [
      schema.nodes['tag']!.create({ id: t2 }, schema.text('Second')),
      schema.nodes['card_body']!.create(null, schema.text('x')),
    ]),
  ]);
  const container = document.createElement('div');
  document.body.appendChild(container);
  const view = new EditorView(container, { state: EditorState.create({ doc }) });
  return { view, t1, t2 };
}

function selectedId(panel: NavigationPanel): string | null {
  const ids = (panel as unknown as Record<string, unknown>)['selectedIds'] as Set<string>;
  return ids.size === 1 ? [...ids][0]! : null;
}

function cachedPos(panel: NavigationPanel, id: string): number {
  const entries = (panel as unknown as Record<string, unknown>)['liEntries'] as Map<
    unknown,
    { id: string | null; pos: number }
  >;
  for (const e of entries.values()) if (e.id === id) return e.pos;
  return -1;
}

function endOfFirstBody(doc: PMNode): number {
  let end = -1;
  doc.descendants((n, pos) => {
    if (end < 0 && n.type.name === 'card_body') end = pos + 1 + n.content.size;
  });
  return end;
}

describe('NavigationPanel caret-tracking (remapPositions)', () => {
  it('keeps the highlight on the current heading while typing just above the next', () => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const { view, t1, t2 } = makeDocAndView();
    const panel = new NavigationPanel(parent, { localMaxLevel: true });
    panel.attach(view);

    const endBody1 = endOfFirstBody(view.state.doc);
    const staleT2 = cachedPos(panel, t2);
    const gap = staleT2 - endBody1; // structural tokens between body end and T2
    const inserted = gap + 1; // type enough to cross T2's stale position
    const newCaret = endBody1 + inserted;

    // Without remapping, the advanced caret lands past the *stale* T2 position,
    // so the next heading lights up — the flicker.
    panel.setCaretHeading(newCaret);
    expect(selectedId(panel)).toBe(t2);

    // Map the cached positions forward through the insertion, then re-track.
    const tr = view.state.tr.insertText('y'.repeat(inserted), endBody1);
    panel.remapPositions(tr.mapping);

    // T2 moved with the doc; T1 (before the edit) didn't.
    expect(cachedPos(panel, t2)).toBe(staleT2 + inserted);
    expect(cachedPos(panel, t1)).toBeLessThan(endBody1);

    panel.setCaretHeading(newCaret);
    expect(selectedId(panel)).toBe(t1); // back under the correct heading — no flicker

    panel.destroy();
    view.destroy();
  });
});
