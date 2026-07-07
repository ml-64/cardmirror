// @vitest-environment jsdom
/**
 * Regression coverage for the refresh-safety fixes (the async `refreshZoneAtPos`
 * path, previously untested):
 *  - it refuses (reason 'ambiguous') rather than overwrite the WRONG same-identity
 *    zone when the clicked pos goes stale during the async source read;
 *  - it re-confirms when the target became edited DURING the read;
 *  - it refuses (reason 'cycle') when the refreshed section transitively
 *    transcludes the very zone being refreshed;
 *  - `deepZoneIdentities` sees nested zone identities at any depth.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { EditorState } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { Fragment, Node as PMNode } from 'prosemirror-model';
import { schema, newHeadingId } from '../../src/schema/index.js';

// Control the source read so we can drive the async gap deterministically.
const { resolveMock } = vi.hoisted(() => ({ resolveMock: vi.fn() }));
vi.mock('../../src/editor/transclusion-resolve.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/editor/transclusion-resolve.js')>();
  return { ...actual, resolveTransclusion: resolveMock };
});

import {
  createTransclusionNode,
  contentHash,
  deepZoneIdentities,
  zoneIdentity,
  isTransclusionNode,
} from '../../src/editor/transclusion.js';
import { refreshZoneAtPos } from '../../src/editor/transclusion-actions.js';

function card(tag: string, body: string): PMNode {
  return schema.nodes['card']!.createChecked(null, [
    schema.nodes['tag']!.create({ id: newHeadingId() }, schema.text(tag)),
    schema.nodes['card_body']!.create(null, schema.text(body)),
  ]);
}
function zoneNode(children: PMNode[], attrs: Record<string, unknown>, edited = false): PMNode {
  const content = Fragment.fromArray(children);
  const hash = edited ? 'stale-hash-does-not-match' : contentHash(content);
  return createTransclusionNode(schema, { source_content_hash: hash, ...attrs }, content);
}
function makeView(children: PMNode[]): EditorView {
  const doc = schema.nodes['doc']!.create(null, children);
  const container = document.createElement('div');
  document.body.appendChild(container);
  return new EditorView(container, { state: EditorState.create({ doc }) });
}
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}
function zoneTextAt(view: EditorView, pos: number): string {
  return view.state.doc.nodeAt(pos)?.textContent ?? '';
}

const REF = { source_ref: 'S.cmir', source_ref_base: 'doc' as const, source_heading_id: 'H' };

beforeEach(() => {
  resolveMock.mockReset();
  // Never let a real prompt block; if a path DID try to confirm we'd rather it
  // proceed than hang — the tests assert on outcome, not the confirm.
  vi.stubGlobal('confirm', vi.fn(() => true));
});

describe('deepZoneIdentities', () => {
  it('finds nested zone identities at any depth', () => {
    const inner = zoneNode([card('Inner', 'x')], { ...REF, source_ref: 'B.cmir', source_heading_id: 'HB' });
    const outer = Fragment.fromArray([card('C', 'y'), inner]);
    const ids = deepZoneIdentities(outer);
    expect(ids.has(zoneIdentity(inner))).toBe(true);
  });
});

describe('refreshZoneAtPos — safety', () => {
  it("refuses (ambiguous) instead of overwriting the WRONG same-identity zone when pos goes stale", async () => {
    // Two live zones with the SAME identity: A (edited) first, B (clean) second.
    const zoneA = zoneNode([card('A', 'A-edited-content')], REF, /* edited */ true);
    const zoneB = zoneNode([card('B', 'B-clean-content')], REF);
    const view = makeView([zoneA, zoneB]);
    const posA = 0;
    const posB = zoneA.nodeSize;
    expect(isTransclusionNode(view.state.doc.nodeAt(posB)!)).toBe(true);

    const d = deferred<unknown>();
    resolveMock.mockReturnValue(d.promise);

    const pending = refreshZoneAtPos(view, posB); // refresh the clean zone B
    // Simulate a concurrent edit landing DURING the async read: insert a block at
    // posB, which shifts zone B and makes the clicked pos stale.
    view.dispatch(view.state.tr.insert(posB, schema.nodes['paragraph']!.create()));
    d.resolve({
      ok: true,
      result: { content: Fragment.fromArray([card('New', 'FRESH-from-source')]), headingLabel: 'H', headingType: 'block' },
      sourceName: 'S.cmir',
    });
    const outcome = await pending;

    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toBe('ambiguous');
    // Crucially, NEITHER zone was overwritten — zone A's edits survive.
    expect(zoneTextAt(view, posA)).toContain('A-edited-content');
    expect(view.state.doc.textContent).not.toContain('FRESH-from-source');
    view.destroy();
  });

  it('refreshes normally when the single target is unambiguous', async () => {
    const view = makeView([zoneNode([card('Old', 'old-ev')], REF)]);
    resolveMock.mockResolvedValue({
      ok: true,
      result: { content: Fragment.fromArray([card('New', 'new-ev')]), headingLabel: 'H', headingType: 'block' },
      sourceName: 'S.cmir',
    });
    const outcome = await refreshZoneAtPos(view, 0);
    expect(outcome.ok).toBe(true);
    expect(view.state.doc.textContent).toContain('new-ev');
    expect(view.state.doc.textContent).not.toContain('old-ev');
    view.destroy();
  });

  it('refuses (cycle) when the refreshed section transitively transcludes this zone', async () => {
    const view = makeView([zoneNode([card('Orig', 'orig-ev')], REF)]);
    // The source section now contains a nested zone pointing back at this target.
    const selfRef = createTransclusionNode(schema, REF, Fragment.fromArray([card('inner', 'z')]));
    resolveMock.mockResolvedValue({
      ok: true,
      result: { content: Fragment.fromArray([selfRef]), headingLabel: 'H', headingType: 'block' },
      sourceName: 'S.cmir',
    });
    const outcome = await refreshZoneAtPos(view, 0);
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toBe('cycle');
    // Cache preserved.
    expect(view.state.doc.textContent).toContain('orig-ev');
    view.destroy();
  });

  it('re-confirms when the zone became edited during the read (and cancel preserves the edit)', async () => {
    const view = makeView([zoneNode([card('T', 'clean-ev')], REF)]);
    const d = deferred<unknown>();
    resolveMock.mockReturnValue(d.promise);
    const confirmSpy = vi.fn(() => false); // user cancels the re-confirm
    vi.stubGlobal('confirm', confirmSpy);

    const pending = refreshZoneAtPos(view, 0);
    // Edit the (clean) zone DURING the read → it becomes edited. Type into the
    // 'clean-ev' body text node.
    let typePos = -1;
    view.state.doc.descendants((n, p) => {
      if (typePos < 0 && n.isText && n.text?.includes('clean-ev')) typePos = p + 1;
      return true;
    });
    view.dispatch(view.state.tr.insertText('ZZZ', typePos));
    d.resolve({
      ok: true,
      result: { content: Fragment.fromArray([card('New', 'from-source')]), headingLabel: 'H', headingType: 'block' },
      sourceName: 'S.cmir',
    });
    const outcome = await pending;

    expect(confirmSpy).toHaveBeenCalled();          // it asked before discarding
    expect(outcome.reason).toBe('cancelled');       // user said no
    expect(view.state.doc.textContent).toContain('ZZZ');          // the edit survived
    expect(view.state.doc.textContent).not.toContain('from-source'); // source not applied
    view.destroy();
  });
});
