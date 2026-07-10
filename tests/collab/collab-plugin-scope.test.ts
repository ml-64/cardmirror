/**
 * Per-doc session scoping — the multi-pane fusion guard AND the foundation for
 * multiple independent sessions in one window.
 *
 * Regression for the released-build bug where opening a second document while a
 * co-editing session was live bound the new pane to the session's shared LoroDoc
 * and overwrote it (doc B "became" doc A). Sessions are now keyed by owning
 * `DocRecord.uid`: `collabPluginsFor(targetUid)` returns a session's binding
 * plugins ONLY for its owning doc, and two sessions coexist independently.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { Plugin } from 'prosemirror-state';
import {
  registerCollabPluginSource,
  unregisterCollabPluginSource,
  collabPluginsFor,
  anyCollabSessionActive,
  type CollabPluginSource,
} from '../../src/editor/collab/collab-hooks.js';

const markerA = new Plugin({});
const markerB = new Plugin({});

function fakeSource(ownerUid: string, marker: Plugin): CollabPluginSource {
  return {
    ownerUid,
    plugins: () => [marker],
    ownsUndo: () => true,
    undo: () => false,
    redo: () => false,
  };
}

afterEach(() => {
  unregisterCollabPluginSource('doc-A');
  unregisterCollabPluginSource('doc-B');
});

describe('per-doc session scoping (fusion guard + multi-session)', () => {
  it('binds a session ONLY to its owning doc uid; other panes stay independent', () => {
    registerCollabPluginSource(fakeSource('doc-A', markerA));
    expect(collabPluginsFor('doc-A')).toEqual([markerA]); // owner: bound
    expect(collabPluginsFor('doc-B')).toEqual([]); // second pane: no binding → no fusion
  });

  it('two sessions coexist, each bound to its OWN doc', () => {
    registerCollabPluginSource(fakeSource('doc-A', markerA));
    registerCollabPluginSource(fakeSource('doc-B', markerB));
    expect(collabPluginsFor('doc-A')).toEqual([markerA]);
    expect(collabPluginsFor('doc-B')).toEqual([markerB]); // independent, not fused
  });

  it('never binds for a null/undefined uid (transient editors, unknown target)', () => {
    registerCollabPluginSource(fakeSource('doc-A', markerA));
    expect(collabPluginsFor(null)).toEqual([]);
    expect(collabPluginsFor(undefined)).toEqual([]);
  });

  it('unregister ends only that doc; the other session stays live', () => {
    registerCollabPluginSource(fakeSource('doc-A', markerA));
    registerCollabPluginSource(fakeSource('doc-B', markerB));
    unregisterCollabPluginSource('doc-A');
    expect(collabPluginsFor('doc-A')).toEqual([]); // ended
    expect(collabPluginsFor('doc-B')).toEqual([markerB]); // still live
  });

  it('anyCollabSessionActive tracks the registry', () => {
    expect(anyCollabSessionActive()).toBe(false);
    registerCollabPluginSource(fakeSource('doc-A', markerA));
    expect(anyCollabSessionActive()).toBe(true);
    unregisterCollabPluginSource('doc-A');
    expect(anyCollabSessionActive()).toBe(false);
  });
});
