/**
 * Verify every internal link in the repo's markdown docs resolves.
 *
 * Two failure modes, both invisible on GitHub — a bad anchor just
 * scrolls nowhere, so stale links survive indefinitely:
 *
 *   - `](#anchor)`            → heading must exist in the same file
 *   - `](OTHER.md#anchor)`    → file must exist, and the anchor in it
 *
 * Section renumbering is what breaks these in practice: insert a
 * section and every `#12-ai-features` below it silently points one
 * section short. (18 links broke that way before this check existed.)
 *
 * Anchors follow GitHub's slug rules: lowercase, drop everything that
 * isn't a word character/space/hyphen, then hyphenate each remaining
 * space INDIVIDUALLY — dropped punctuation leaves its spaces behind, so
 * "Web app (Chromebook & browser)" really does anchor at
 * `web-app-chromebook--browser`. Repeated headings get a `-1`/`-2`
 * suffix.
 *
 * Run: npm run check:links
 */

import { readFileSync, existsSync, globSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** GitHub's heading → anchor slug, including its duplicate suffixes. */
function slug(heading, seen) {
  const base = heading
    .trim()
    // Inline markdown that never reaches the rendered anchor text:
    // links keep their label, emphasis/code markers just vanish.
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`~]/g, '')
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    // Per-space, not /\s+/ — collapsing here would reject valid anchors.
    .replace(/\s/g, '-');
  const n = seen.get(base) ?? 0;
  seen.set(base, n + 1);
  return n === 0 ? base : `${base}-${n}`;
}

/** Every anchor a file's headings define. */
function anchorsOf(path) {
  const seen = new Map();
  const out = new Set();
  let inFence = false;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    // Fenced code can contain #-prefixed lines that aren't headings.
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    else if (!inFence) {
      const m = /^(#{1,6})\s+(.*)$/.exec(line);
      if (m) out.add(slug(m[2], seen));
    }
  }
  return out;
}

const docs = globSync('*.md', { cwd: REPO }).sort();
const anchorCache = new Map();
const anchors = (p) => {
  if (!anchorCache.has(p)) anchorCache.set(p, anchorsOf(p));
  return anchorCache.get(p);
};

let checked = 0;
const problems = [];

for (const doc of docs) {
  const path = join(REPO, doc);
  const lines = readFileSync(path, 'utf8').split('\n');
  lines.forEach((line, i) => {
    // Link targets only — bare `#hashes` in prose are not links.
    for (const m of line.matchAll(/\]\(([^)\s]+)\)/g)) {
      const target = m[1];
      // External and absolute links are out of scope (no network here).
      if (/^(https?:|mailto:|#?\/)/.test(target)) continue;
      const [file, anchor] = target.split('#');
      checked++;
      const where = `${doc}:${i + 1}`;

      if (file) {
        const other = join(REPO, dirname(doc) === '.' ? '' : dirname(doc), file);
        if (!existsSync(other)) {
          problems.push(`${where}  missing file: ${file}`);
          continue;
        }
        if (anchor && other.endsWith('.md') && !anchors(other).has(anchor)) {
          problems.push(`${where}  no heading "#${anchor}" in ${file}`);
        }
      } else if (anchor && !anchors(path).has(anchor)) {
        problems.push(`${where}  no heading "#${anchor}"`);
      }
    }
  });
}

if (problems.length) {
  console.error(`Broken links (${problems.length} of ${checked} checked):\n`);
  for (const p of problems) console.error('  ' + p);
  console.error(
    '\nUsually a section was renumbered and its inbound links kept the old number.',
  );
  process.exit(1);
}

console.log(`All ${checked} internal links resolve (${docs.length} docs).`);
