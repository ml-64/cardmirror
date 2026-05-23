/**
 * CardMirror native file format (`.cmir`).
 *
 * The "no-roundtrip" save path: serialize the ProseMirror document
 * straight to JSON with a small format envelope, persist it as-is,
 * and parse it back without any conversion loss. Files saved this
 * way preserve everything the schema can express (including things
 * docx round-trip drops or rewrites — structural intent that
 * Word style-guessing can't recover, etc.).
 *
 * Users still get full `.docx` support for sharing with Verbatim
 * teammates; `.cmir` is the long-term canonical form for docs that
 * live entirely inside the CardMirror ecosystem.
 *
 * Format shape (current `formatVersion`):
 *
 *   {
 *     "format": "cardmirror-doc",
 *     "formatVersion": 1,
 *     "createdBy": "CardMirror 0.x",
 *     "createdAt": "2026-…",
 *     "doc": { ...PM-doc JSON },
 *     "threads": [ ...Thread[] ]   // optional
 *   }
 *
 * Plain JSON, pretty-printed for git-friendliness and inspectability.
 * Future enhancements (binary frame for images, compression, etc.)
 * can ride formatVersion bumps; v1 keeps it simple.
 */

import type { Node as PMNode } from 'prosemirror-model';
import { schema } from '../schema/index.js';
import type { Thread } from '../editor/comments-plugin.js';

/** Magic identifier present in every CardMirror native file. Rejects
 *  arbitrary JSON files. */
const FORMAT_ID = 'cardmirror-doc';

/** Current format version. Bump when the envelope or doc-JSON shape
 *  changes in a way that requires migration on parse. */
const FORMAT_VERSION = 1;

/** Canonical file extension (no leading dot). */
export const NATIVE_FILE_EXTENSION = 'cmir';

export interface NativeFile {
  format: typeof FORMAT_ID;
  formatVersion: number;
  /** App version that produced the file. Informational. */
  createdBy: string;
  /** ISO 8601 timestamp. */
  createdAt: string;
  /** ProseMirror doc JSON. Round-tripped via `PMNode.toJSON` and
   *  `Schema.nodeFromJSON`. */
  doc: unknown;
  /** Comment threads, if any. Omitted from the file when empty. */
  threads?: Thread[];
}

export interface SerializeNativeOptions {
  /** Comment threads to embed alongside the doc. Omit when there
   *  are none. */
  threads?: readonly Thread[];
  /** App version string written into `createdBy`. Defaults to a
   *  generic "CardMirror" if not supplied. */
  appVersion?: string;
}

/** Serialize a ProseMirror doc + optional threads to bytes in the
 *  CardMirror native format. */
export function serializeNative(
  doc: PMNode,
  opts: SerializeNativeOptions = {},
): Uint8Array {
  const file: NativeFile = {
    format: FORMAT_ID,
    formatVersion: FORMAT_VERSION,
    createdBy: opts.appVersion ?? 'CardMirror',
    createdAt: new Date().toISOString(),
    doc: doc.toJSON(),
  };
  if (opts.threads && opts.threads.length > 0) {
    file.threads = [...opts.threads];
  }
  // Pretty-print for diffability + manual inspection. JSON whitespace
  // is recoverable on the next save anyway, so the cost is minimal.
  const json = JSON.stringify(file, null, 2);
  return new TextEncoder().encode(json);
}

export interface ParseNativeResult {
  doc: PMNode;
  /** Empty array when the file had no threads. */
  threads: Thread[];
  meta: {
    createdBy: string;
    createdAt: string;
    formatVersion: number;
  };
}

/** Parse CardMirror native bytes back into a doc + threads. Throws
 *  with a descriptive message when the bytes aren't a valid CardMirror
 *  file — caller can show that to the user. */
export function parseNative(bytes: Uint8Array): ParseNativeResult {
  let parsed: unknown;
  try {
    const text = new TextDecoder().decode(bytes);
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(
      `Not a CardMirror file: failed to parse JSON (${err instanceof Error ? err.message : err}).`,
    );
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('Not a CardMirror file: expected a JSON object.');
  }
  const file = parsed as Partial<NativeFile>;
  if (file.format !== FORMAT_ID) {
    throw new Error(
      `Not a CardMirror file: missing or unrecognized format identifier (${String(file.format)}).`,
    );
  }
  if (typeof file.formatVersion !== 'number') {
    throw new Error('CardMirror file is missing formatVersion.');
  }
  if (file.formatVersion > FORMAT_VERSION) {
    throw new Error(
      `CardMirror file uses formatVersion ${file.formatVersion}, which is newer than this build supports (max ${FORMAT_VERSION}). Update CardMirror to read this file.`,
    );
  }
  if (file.doc === undefined) {
    throw new Error('CardMirror file is missing its doc field.');
  }
  const doc = schema.nodeFromJSON(file.doc);
  return {
    doc,
    threads: Array.isArray(file.threads) ? file.threads : [],
    meta: {
      createdBy: typeof file.createdBy === 'string' ? file.createdBy : '',
      createdAt: typeof file.createdAt === 'string' ? file.createdAt : '',
      formatVersion: file.formatVersion,
    },
  };
}

/** Quick non-throwing check for whether bytes start with our format
 *  identifier — useful for ambiguous file picks where the extension
 *  is missing or unreliable. */
export function looksLikeNative(bytes: Uint8Array): boolean {
  // Peek at the first ~120 chars; the `format` key lands in the
  // first few-dozen bytes of any well-formed file we produce.
  const head = new TextDecoder().decode(bytes.subarray(0, 256));
  return head.includes(`"${FORMAT_ID}"`);
}
