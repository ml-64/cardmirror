/**
 * View-operating transclusion actions: refresh, detach, insert. Shared by the
 * NodeView header buttons and the ribbon commands. Refresh is async (it reads
 * the source file); detach and insert are synchronous transactions.
 */
import { NodeSelection } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import type { Node as PMNode, Schema } from 'prosemirror-model';
import { newHeadingId } from '../schema/index.js';
import {
  isTransclusionNode,
  zoneIdentity,
  detachSlice,
  createTransclusionNode,
  extractSection,
  chooseSourceRef,
  directZoneIdentities,
  fragmentFromCache,
  type TransclusionAttrs,
} from './transclusion.js';
import { getViewDocPath } from './transclusion-doc-path.js';
import { resolveTransclusion, type ResolveOutcome } from './transclusion-resolve.js';

/** " › " with explicit code points (space, U+203A, space). */
const CRUMB_SEP = ' › ';

/** Breadcrumb label: "SourceFile › Heading" (drops the `.cmir` extension). */
export function crumbLabel(sourceName: string, headingLabel: string): string {
  const base = sourceName.replace(/\.cmir$/i, '');
  return base ? `${base}${CRUMB_SEP}${headingLabel}` : headingLabel;
}

export type BuildZoneReason =
  | 'no-heading-id'
  | 'no-section'
  | 'no-doc-path'
  | 'no-portable-ref'
  | 'self-cycle';

export interface BuildZoneOutcome {
  ok: boolean;
  reason?: BuildZoneReason;
  attrs?: TransclusionAttrs;
  headingLabel?: string;
}

/**
 * Build the attrs for a new live zone from an already-parsed source doc + a
 * target heading id. Shared by every creation entry point (the picker's
 * transclude mode and per-header Mod+Enter). Snapshots the section now,
 * computes a portable source ref, and rejects direct self-embedding. Pure aside
 * from the `last_refreshed` timestamp, so it's unit-testable.
 */
export function buildLiveZoneAttrs(
  schema: Schema,
  sourceDoc: PMNode,
  headingId: string,
  sourceName: string,
  docPath: string | null,
  sourceAbsPath: string,
  roots: readonly string[],
): BuildZoneOutcome {
  if (!headingId) return { ok: false, reason: 'no-heading-id' };
  const section = extractSection(sourceDoc, headingId);
  if (!section) return { ok: false, reason: 'no-section' };
  if (!docPath) return { ok: false, reason: 'no-doc-path' };
  const chosen = chooseSourceRef(docPath, sourceAbsPath, roots);
  if (!chosen) return { ok: false, reason: 'no-portable-ref' };
  const attrs: TransclusionAttrs = {
    source_ref: chosen.ref,
    source_ref_base: chosen.base,
    source_heading_id: headingId,
    content_hash: section.contentHash,
    cached_content: section.cachedContent,
    last_refreshed: Date.now(),
    source_label: crumbLabel(sourceName, section.headingLabel),
  };
  const node = createTransclusionNode(schema, attrs);
  if (directZoneIdentities(fragmentFromCache(schema, section.cachedContent)).has(zoneIdentity(node))) {
    return { ok: false, reason: 'self-cycle' };
  }
  return { ok: true, attrs, headingLabel: section.headingLabel };
}

/** Toast message for a failed live-zone build. */
export function buildZoneErrorMessage(reason: BuildZoneReason | undefined): string {
  switch (reason) {
    case 'no-heading-id':
      return 'That heading has no stable id — open and save the source in CardMirror, then retry.';
    case 'no-section':
      return 'Could not read that section from the source.';
    case 'no-doc-path':
      return 'Save this document first, then insert a live zone.';
    case 'no-portable-ref':
      return 'Couldn’t make a portable link to that file.';
    case 'self-cycle':
      return 'That section transcludes itself — can’t create a cycle.';
    default:
      return 'Could not insert the live zone.';
  }
}

/** Re-locate a zone after an async gap: prefer the original pos, else the first
 *  zone in the doc with the same identity (the user may have edited meanwhile). */
function findZonePos(doc: PMNode, identity: string, preferredPos: number): number | null {
  const at = doc.nodeAt(preferredPos);
  if (at && isTransclusionNode(at) && zoneIdentity(at) === identity) return preferredPos;
  let found: number | null = null;
  doc.descendants((n, pos) => {
    if (found !== null) return false;
    if (isTransclusionNode(n) && zoneIdentity(n) === identity) {
      found = pos;
      return false;
    }
    return true;
  });
  return found;
}

/**
 * Refresh the zone at `pos`: read its source, extract the section, and replace
 * the cache. Returns the resolve outcome so the caller can surface failures
 * (the NodeView shows an "unreachable" chip; a command shows a toast). On
 * success the doc is updated in place; on failure nothing changes (the cache
 * keeps rendering). Best-effort — never throws.
 */
export async function refreshZoneAtPos(
  view: EditorView,
  pos: number,
): Promise<ResolveOutcome> {
  const node = view.state.doc.nodeAt(pos);
  if (!node || !isTransclusionNode(node)) return { ok: false, reason: 'heading-missing' };
  const identity = zoneIdentity(node);
  const docPath = getViewDocPath(view);
  const outcome = await resolveTransclusion(
    docPath,
    String(node.attrs['source_ref'] ?? ''),
    node.attrs['source_ref_base'] === 'root' ? 'root' : 'doc',
    String(node.attrs['source_heading_id'] ?? ''),
  );
  if (!outcome.ok || !outcome.result) return outcome;

  const targetPos = findZonePos(view.state.doc, identity, pos);
  if (targetPos === null) return outcome; // zone vanished mid-refresh; drop silently
  const live = view.state.doc.nodeAt(targetPos);
  if (!live || !isTransclusionNode(live)) return outcome;

  const tr = view.state.tr.setNodeMarkup(targetPos, undefined, {
    ...live.attrs,
    cached_content: outcome.result.cachedContent,
    content_hash: outcome.result.contentHash,
    last_refreshed: Date.now(),
    source_label: crumbLabel(outcome.sourceName ?? '', outcome.result.headingLabel),
  });
  tr.setMeta('addToHistory', true);
  view.dispatch(tr);
  return outcome;
}

/**
 * Detach the zone at `pos`: replace it with its cached cards as ordinary
 * editable content (heading ids rewritten), breaking the link. An empty cache
 * just removes the zone. Returns false if there's no zone there.
 */
export function detachZoneAtPos(view: EditorView, pos: number): boolean {
  const node = view.state.doc.nodeAt(pos);
  if (!node || !isTransclusionNode(node)) return false;
  const slice = detachSlice(view.state.schema, node, newHeadingId);
  const tr = view.state.tr.replaceRange(pos, pos + node.nodeSize, slice);
  view.dispatch(tr.scrollIntoView());
  return true;
}

/**
 * Insert a new live zone after the top-level block containing the selection,
 * and select it. Returns false if the schema won't allow it (shouldn't happen
 * at the doc root).
 */
export function insertZoneAtSelection(
  view: EditorView,
  attrs: Partial<TransclusionAttrs>,
): boolean {
  const node = createTransclusionNode(view.state.schema, attrs);
  const { $from } = view.state.selection;
  const pos = $from.depth > 0 ? $from.after(1) : $from.pos;
  let tr = view.state.tr.insert(pos, node);
  try {
    tr = tr.setSelection(NodeSelection.create(tr.doc, pos));
  } catch {
    // Selection placement is best-effort.
  }
  view.dispatch(tr.scrollIntoView());
  return true;
}
