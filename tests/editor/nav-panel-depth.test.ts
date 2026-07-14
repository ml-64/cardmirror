// @vitest-environment jsdom
/**
 * Nav-pane depth semantics (field request 2026-07-14): `navMaxLevel` is
 * the DEFAULT depth for newly opened documents ("Default navigation
 * depth", Settings → General), while the pane's 1–4 buttons are a
 * transient per-doc view change that never writes the setting. Both
 * layouts share this: every panel is per-instance now (the old
 * single-pane behavior wrote every button click through to settings,
 * making the last click the de-facto default).
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { EditorState } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { schema, newHeadingId } from '../../src/schema/index.js';
import { NavigationPanel } from '../../src/editor/nav-panel.js';
import { settings } from '../../src/editor/settings.js';

function makeView(): EditorView {
  const doc = schema.nodes['doc']!.create(null, [
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

const depthOf = (p: NavigationPanel): number =>
  (p as unknown as { localMaxLevel: number }).localMaxLevel;

function clickLevel(p: NavigationPanel, level: number): void {
  const root = (p as unknown as { root: HTMLElement }).root;
  const btn = root.querySelector<HTMLButtonElement>(
    `.pmd-nav-level-btn[data-level="${level}"]`,
  );
  btn!.click();
}

beforeEach(() => settings.set('navMaxLevel', 2));
afterEach(() => settings.set('navMaxLevel', 3));

describe('nav-pane depth: default-for-new-docs semantics', () => {
  it('a newly attached doc opens at the configured default', () => {
    const view = makeView();
    const panel = new NavigationPanel(document.createElement('div'));
    panel.attach(view);
    expect(depthOf(panel)).toBe(2);
    panel.destroy();
    view.destroy();
  });

  it('level clicks are transient: the setting is never written', () => {
    const view = makeView();
    const panel = new NavigationPanel(document.createElement('div'));
    panel.attach(view);
    clickLevel(panel, 4);
    expect(depthOf(panel)).toBe(4); // the view changed…
    expect(settings.get('navMaxLevel')).toBe(2); // …the default did not
    panel.destroy();
    view.destroy();
  });

  it('re-attach (a new doc) resets the depth to the default', () => {
    const view = makeView();
    const panel = new NavigationPanel(document.createElement('div'));
    panel.attach(view);
    clickLevel(panel, 4);
    const view2 = makeView();
    panel.attach(view2); // open a different doc into the same panel
    expect(depthOf(panel)).toBe(2);
    panel.destroy();
    view.destroy();
    view2.destroy();
  });

  it('changing the setting affects NEW docs only, not the open one', () => {
    const view = makeView();
    const panel = new NavigationPanel(document.createElement('div'));
    panel.attach(view);
    clickLevel(panel, 4);
    settings.set('navMaxLevel', 1);
    expect(depthOf(panel)).toBe(4); // open doc untouched
    const view2 = makeView();
    panel.attach(view2);
    expect(depthOf(panel)).toBe(1); // next doc picks it up
    panel.destroy();
    view.destroy();
    view2.destroy();
  });
});
