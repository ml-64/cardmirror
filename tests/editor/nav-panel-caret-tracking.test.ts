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
    const panel = new NavigationPanel(parent);
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

describe('setCaretHeading — preserveMultiSelect (positional resyncs)', () => {
  function multiSelect(panel: NavigationPanel, ids: string[]): void {
    const p = panel as unknown as {
      selectedIds: Set<string>;
      selectionLevel: number | null;
      selectionAnchorId: string | null;
    };
    p.selectedIds = new Set(ids);
    p.selectionLevel = 4;
    p.selectionAnchorId = ids[0] ?? null;
  }
  function selectedCount(panel: NavigationPanel): number {
    return ((panel as unknown as Record<string, unknown>)['selectedIds'] as Set<string>).size;
  }
  /** Caret position inside the FIRST card's tag text. */
  function caretInFirstTag(view: EditorView): number {
    let p = -1;
    view.state.doc.descendants((n, pos) => {
      if (p < 0 && n.type.name === 'tag') p = pos + 1;
      return p < 0;
    });
    return p;
  }

  it('a resync keeps an explicit multi-select whose member holds the caret', () => {
    const { view, t1, t2 } = makeDocAndView();
    const panel = new NavigationPanel(document.createElement('div'));
    panel.attach(view);
    panel.update(view.state.doc);
    multiSelect(panel, [t1, t2]);
    // The post-rebuild resync (e.g. after a numbering toggle edited these
    // very cards) must not collapse the group the user is toggling.
    panel.setCaretHeading(caretInFirstTag(view), null, { preserveMultiSelect: true });
    expect(selectedCount(panel)).toBe(2);
    panel.destroy();
    view.destroy();
  });

  it('a REAL caret move (no flag) still collapses to a single selection', () => {
    const { view, t1, t2 } = makeDocAndView();
    const panel = new NavigationPanel(document.createElement('div'));
    panel.attach(view);
    panel.update(view.state.doc);
    multiSelect(panel, [t1, t2]);
    panel.setCaretHeading(caretInFirstTag(view));
    expect(selectedCount(panel)).toBe(1);
    expect(selectedId(panel)).toBe(t1);
    panel.destroy();
    view.destroy();
  });

  it('a resync whose caret heading is OUTSIDE the group collapses (reflects reality)', () => {
    // Three cards: the group covers Second + Third, the caret sits in First.
    const ids = [newHeadingId(), newHeadingId(), newHeadingId()];
    const doc = schema.nodes['doc']!.create(
      null,
      ['First', 'Second', 'Third'].map((t, i) =>
        schema.nodes['card']!.create(null, [
          schema.nodes['tag']!.create({ id: ids[i] }, schema.text(t)),
          schema.nodes['card_body']!.create(null, schema.text('body')),
        ]),
      ),
    );
    const container = document.createElement('div');
    document.body.appendChild(container);
    const view = new EditorView(container, { state: EditorState.create({ doc }) });
    const panel = new NavigationPanel(document.createElement('div'));
    panel.attach(view);
    panel.update(view.state.doc);
    multiSelect(panel, [ids[1]!, ids[2]!]);
    panel.setCaretHeading(caretInFirstTag(view), null, { preserveMultiSelect: true });
    expect(selectedCount(panel)).toBe(1);
    expect(selectedId(panel)).toBe(ids[0]!);
    panel.destroy();
    view.destroy();
  });

  it('preserve flag + a SINGLE selection behaves exactly like today (caret mirror)', () => {
    const { view, t1 } = makeDocAndView();
    const panel = new NavigationPanel(document.createElement('div'));
    panel.attach(view);
    panel.update(view.state.doc);
    multiSelect(panel, [t1]); // size 1 — not an explicit multi-select
    panel.setCaretHeading(caretInFirstTag(view), null, { preserveMultiSelect: true });
    expect(selectedCount(panel)).toBe(1);
    expect(selectedId(panel)).toBe(t1);
    panel.destroy();
    view.destroy();
  });
});
