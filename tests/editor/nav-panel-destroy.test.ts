// @vitest-environment jsdom

/**
 * NavigationPanel.destroy() — the multi-pane shell creates one panel
 * per open doc; destroy must release the settings/drag subscriptions
 * and the doc snapshot, or a closed pane's panel stays alive for the
 * session, pinning its full doc.
 */

import { describe, expect, it } from 'vitest';
import { EditorState } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { schema, newHeadingId } from '../../src/schema/index.js';
import { NavigationPanel } from '../../src/editor/nav-panel.js';

function makeView(): EditorView {
  const doc = schema.nodes['doc']!.create(null, [
    schema.nodes['pocket']!.create({ id: newHeadingId() }, schema.text('Pocket')),
    schema.nodes['block']!.create({ id: newHeadingId() }, schema.text('Block')),
    schema.nodes['card']!.create(null, [
      schema.nodes['tag']!.create({ id: newHeadingId() }, schema.text('Tag')),
      schema.nodes['card_body']!.create(null, schema.text('body')),
    ]),
  ]);
  const container = document.createElement('div');
  document.body.appendChild(container);
  return new EditorView(container, { state: EditorState.create({ doc }) });
}

describe('NavigationPanel.destroy', () => {
  it('releases subscriptions, the doc snapshot, and its DOM', () => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const view = makeView();
    const panel = new NavigationPanel(parent);
    panel.attach(view);

    const internals = panel as unknown as Record<string, unknown>;
    expect(internals['currentDoc']).not.toBeNull();
    expect(internals['unsubscribeSettings']).not.toBeNull();
    expect(internals['unsubscribeDrag']).not.toBeNull();
    expect(internals['unregisterSurface']).not.toBeNull();
    expect(parent.childElementCount).toBeGreaterThan(0);

    panel.destroy();

    expect(internals['currentDoc']).toBeNull();
    expect(internals['view']).toBeNull();
    expect(internals['unsubscribeSettings']).toBeNull();
    expect(internals['unsubscribeDrag']).toBeNull();
    expect(internals['unregisterSurface']).toBeNull();
    expect((internals['liEntries'] as Map<unknown, unknown>).size).toBe(0);
    expect(parent.childElementCount).toBe(0);

    view.destroy();
  });

  it('a late update() after destroy must not re-pin the doc', () => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const view = makeView();
    const panel = new NavigationPanel(parent);
    panel.attach(view);
    panel.destroy();

    // The shell cancels the debounced heavy-update timer on close, but
    // a stray late call must stay a no-op rather than resurrect the
    // snapshot the destroy just released.
    panel.update(view.state.doc);
    const internals = panel as unknown as Record<string, unknown>;
    expect(internals['currentDoc']).toBeNull();

    expect(() => panel.destroy()).not.toThrow(); // idempotent

    view.destroy();
  });
});
