// @vitest-environment jsdom
/**
 * Live zones in a real EditorView (editable child-content model): NodeView
 * rendering, editable content + "edited" indicator, outline inclusion, detach /
 * insert transactions, refresh replacement, and the glyph menu.
 */
import { describe, expect, it } from 'vitest';
import { EditorState, TextSelection, NodeSelection } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { Fragment, Node as PMNode } from 'prosemirror-model';
import { schema, newHeadingId } from '../../src/schema/index.js';
import { editorNodeViews } from '../../src/editor/image-resize-nodeview.js';
import {
  createTransclusionNode,
  contentHash,
  isTransclusionNode,
} from '../../src/editor/transclusion.js';
import {
  detachZoneAtPos,
  insertZoneAtSelection,
} from '../../src/editor/transclusion-actions.js';
import { collectHeadings } from '../../src/editor/headings.js';

function card(tag: string, body: string): PMNode {
  return schema.nodes['card']!.createChecked(null, [
    schema.nodes['tag']!.create({ id: newHeadingId() }, schema.text(tag)),
    schema.nodes['card_body']!.create(null, schema.text(body)),
  ]);
}
/** A zone whose stored hash matches its content (i.e. not edited). */
function freshZone(children: PMNode[], attrs: Record<string, unknown> = {}): PMNode {
  const content = Fragment.fromArray(children);
  return createTransclusionNode(schema, { source_content_hash: contentHash(content), ...attrs }, content);
}
function makeView(children: PMNode[]): EditorView {
  const doc = schema.nodes['doc']!.create(null, children);
  const container = document.createElement('div');
  document.body.appendChild(container);
  return new EditorView(container, {
    state: EditorState.create({ doc }),
    nodeViews: editorNodeViews,
  });
}
function countTypes(view: EditorView): { cards: number; zones: number } {
  let cards = 0;
  let zones = 0;
  view.state.doc.descendants((n) => {
    if (n.type.name === 'card') cards++;
    if (isTransclusionNode(n)) zones++;
    return true;
  });
  return { cards, zones };
}
function textPosOf(view: EditorView, needle: string): number {
  let pos = -1;
  view.state.doc.descendants((n, p) => {
    if (pos < 0 && n.isText && n.text?.includes(needle)) pos = p;
    return true;
  });
  return pos;
}

describe('live zone in a real EditorView (editable)', () => {
  it('renders through the NodeView — rail glyph + editable body + cached cards', () => {
    const zone = freshZone([card('Tag A', 'evidence A'), card('Tag B', 'evidence B')], {
      source_label: 'Src to Block',
    });
    const view = makeView([schema.nodes['paragraph']!.create(), zone]);
    const el = view.dom.querySelector('.pmd-transclusion')!;
    expect(el).toBeTruthy();
    expect(el.querySelector('.pmd-transclusion-glyph')).toBeTruthy();
    expect(el.querySelector('.pmd-transclusion-body')).toBeTruthy();
    expect(el.textContent).toContain('evidence A');
    expect(el.querySelectorAll('.pmd-card').length).toBe(2);
    // The header chrome is not editable; the body is (no contenteditable=false).
    expect(el.querySelector('.pmd-transclusion-header')!.getAttribute('contenteditable')).toBe('false');
    view.destroy();
  });

  it('transcluded cards appear in the outline (Find/nav)', () => {
    const zone = freshZone([card('Transcluded Tag', 'ev')]);
    const view = makeView([
      schema.nodes['block']!.create({ id: newHeadingId() }, schema.text('My Block')),
      zone,
    ]);
    const headings = collectHeadings(view.state.doc);
    const texts = headings.map((h) => h.text);
    expect(texts).toContain('My Block');
    expect(texts).toContain('Transcluded Tag'); // the transcluded card's tag is a real heading now
    view.destroy();
  });

  it('editing content lights the "edited" dot', () => {
    const zone = freshZone([card('T', 'evidence')]);
    const view = makeView([zone]);
    // Not edited yet.
    expect(view.dom.querySelector('.pmd-transclusion-edited-dot.is-edited')).toBeNull();
    // Type into the card body (a real content change inside the isolating zone).
    const pos = textPosOf(view, 'evidence');
    expect(pos).toBeGreaterThan(0);
    view.dispatch(view.state.tr.insertText('X', pos + 1));
    // Now the zone diverges from source → the dot lights.
    expect(view.dom.querySelector('.pmd-transclusion-edited-dot.is-edited')).toBeTruthy();
    expect(view.dom.querySelector('.pmd-transclusion.pmd-transclusion-edited')).toBeTruthy();
    view.destroy();
  });

  it('detach replaces the zone with editable cards; no zone left', () => {
    const view = makeView([freshZone([card('T1', 'e1'), card('T2', 'e2')])]);
    // The zone's cards are real nodes now, so they count even before detach.
    expect(countTypes(view)).toEqual({ cards: 2, zones: 1 });
    expect(detachZoneAtPos(view, 0)).toBe(true);
    expect(countTypes(view)).toEqual({ cards: 2, zones: 0 });
    expect(view.state.doc.textContent).toContain('e1');
    view.destroy();
  });

  it('detach of an empty zone just removes it', () => {
    const view = makeView([
      createTransclusionNode(schema, {}),
      schema.nodes['paragraph']!.create(null, schema.text('after')),
    ]);
    detachZoneAtPos(view, 0);
    expect(countTypes(view).zones).toBe(0);
    expect(view.state.doc.textContent).toContain('after');
    view.destroy();
  });

  it('insertZoneAtSelection inserts one zone at the top level, selected', () => {
    const view = makeView([schema.nodes['paragraph']!.create(null, schema.text('hello'))]);
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 2)));
    const ok = insertZoneAtSelection(
      view,
      { source_ref: 'a.cmir', source_heading_id: 'h1', source_label: 'Src to X' },
      Fragment.fromArray([card('X', 'y')]),
    );
    expect(ok).toBe(true);
    expect(countTypes(view).zones).toBe(1);
    expect(view.state.selection instanceof NodeSelection).toBe(true);
    expect(view.dom.querySelector('.pmd-transclusion')).toBeTruthy();
    view.destroy();
  });

  it('a refresh replacement (replaceWith) re-renders the body', () => {
    const view = makeView([freshZone([card('Old Tag', 'old evidence')], { last_refreshed: 1 })]);
    expect(view.dom.querySelector('.pmd-transclusion')!.textContent).toContain('old evidence');
    const newContent = Fragment.fromArray([card('New Tag', 'new evidence')]);
    const newNode = createTransclusionNode(
      view.state.schema,
      { source_content_hash: contentHash(newContent), last_refreshed: 2 },
      newContent,
    );
    const old = view.state.doc.nodeAt(0)!;
    view.dispatch(view.state.tr.replaceWith(0, old.nodeSize, newNode));
    const el = view.dom.querySelector('.pmd-transclusion')!;
    expect(el.textContent).toContain('new evidence');
    expect(el.textContent).not.toContain('old evidence');
    view.destroy();
  });

  it('clicking the rail glyph opens the actions menu; Unlink detaches', () => {
    const view = makeView([freshZone([card('T', 'ev')])]);
    const glyphBtn = view.dom.querySelector('.pmd-transclusion-glyph-btn') as HTMLElement;
    expect(glyphBtn).toBeTruthy();
    expect(view.dom.querySelector('.pmd-transclusion-menu')).toBeNull();
    glyphBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    const items = view.dom.querySelectorAll('.pmd-transclusion-menu .pmd-transclusion-menu-item');
    // Open source file · Refresh from source · Re-pick source · Unlink (detach)
    expect(items.length).toBe(4);
    const unlink = Array.from(items).find((el) => el.textContent?.includes('Unlink')) as HTMLElement;
    unlink.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(countTypes(view).zones).toBe(0);
    expect(countTypes(view).cards).toBe(1);
    view.destroy();
  });
});
