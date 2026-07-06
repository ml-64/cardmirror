// @vitest-environment node
/**
 * buildLiveZoneAttrs — the shared logic behind both creation entry points (the
 * picker's transclude mode and per-header Mod+Enter in normal file search):
 * snapshot the section, choose a portable ref, reject self-embedding.
 */
import { describe, expect, it } from 'vitest';
import { Node as PMNode } from 'prosemirror-model';
import { schema, newHeadingId } from '../../src/schema/index.js';
import { chooseSourceRef, createTransclusionNode } from '../../src/editor/transclusion.js';
import { buildLiveZoneAttrs } from '../../src/editor/transclusion-actions.js';

function heading(type: string, text: string, id: string): PMNode {
  return schema.nodes[type]!.create({ id }, schema.text(text));
}
function card(tag: string, body: string): PMNode {
  return schema.nodes['card']!.createChecked(null, [
    schema.nodes['tag']!.create({ id: newHeadingId() }, schema.text(tag)),
    schema.nodes['card_body']!.create(null, schema.text(body)),
  ]);
}
function doc(children: PMNode[]): PMNode {
  return schema.nodes['doc']!.createChecked(null, children);
}

const ROOT = '/Dropbox/Debate';
const DOCPATH = '/Dropbox/Debate/Speeches/1AC.cmir';
const SRCPATH = '/Dropbox/Debate/Impacts/Warming.cmir';

describe('buildLiveZoneAttrs — success', () => {
  const src = doc([heading('block', 'Warming', 'wid'), card('T1', 'e1'), card('T2', 'e2')]);

  it('builds header-excluded attrs with a root-relative ref and a breadcrumb', () => {
    const out = buildLiveZoneAttrs(schema, src, 'wid', 'Warming.cmir', DOCPATH, SRCPATH, [ROOT]);
    expect(out.ok).toBe(true);
    const a = out.attrs!;
    expect(a.source_ref).toBe('Impacts/Warming.cmir');
    expect(a.source_ref_base).toBe('root');
    expect(a.source_heading_id).toBe('wid');
    expect(a.cached_content!.length).toBe(2); // two cards, header excluded
    expect(JSON.stringify(a.cached_content)).not.toContain('Warming'); // header line dropped
    expect(a.source_label).toBe('Warming › Warming'); // file (ext stripped) › heading
    expect(typeof a.last_refreshed).toBe('number');
    expect(out.headingLabel).toBe('Warming');
  });

  it('falls back to a doc-relative ref when no shared root', () => {
    const out = buildLiveZoneAttrs(schema, src, 'wid', 'Warming.cmir', DOCPATH, SRCPATH, []);
    expect(out.attrs!.source_ref).toBe('../Impacts/Warming.cmir');
    expect(out.attrs!.source_ref_base).toBe('doc');
  });
});

describe('buildLiveZoneAttrs — rejections', () => {
  const src = doc([heading('block', 'Warming', 'wid'), card('T', 'e')]);

  it('no heading id', () => {
    expect(buildLiveZoneAttrs(schema, src, '', 'S.cmir', DOCPATH, SRCPATH, [ROOT]).reason).toBe('no-heading-id');
  });
  it('heading id not in source', () => {
    expect(buildLiveZoneAttrs(schema, src, 'nope', 'S.cmir', DOCPATH, SRCPATH, [ROOT]).reason).toBe('no-section');
  });
  it('no doc path (unsaved doc)', () => {
    expect(buildLiveZoneAttrs(schema, src, 'wid', 'S.cmir', null, SRCPATH, [ROOT]).reason).toBe('no-doc-path');
  });
  it('no portable ref (different drives, no root)', () => {
    const r = buildLiveZoneAttrs(schema, src, 'wid', 'S.cmir', 'C:\\a\\Doc.cmir', 'D:\\b\\S.cmir', []);
    expect(r.reason).toBe('no-portable-ref');
  });
  it('self-cycle: the section already transcludes itself', () => {
    // Compute the ref this insert would produce, then embed a matching zone
    // in the source section so the self-embed guard fires.
    const chosen = chooseSourceRef(DOCPATH, SRCPATH, [ROOT])!;
    const selfZone = createTransclusionNode(schema, {
      source_ref: chosen.ref,
      source_ref_base: chosen.base,
      source_heading_id: 'wid',
    });
    const selfSrc = doc([heading('block', 'Warming', 'wid'), selfZone, card('T', 'e')]);
    const r = buildLiveZoneAttrs(schema, selfSrc, 'wid', 'Warming.cmir', DOCPATH, SRCPATH, [ROOT]);
    expect(r.reason).toBe('self-cycle');
  });
});
