/**
 * `please <command name>` (SPEC-voice.md §5): fuzzy-match a spoken
 * command name against the ribbon registry — labels plus search
 * aliases — the voice equivalent of the command palette. Every spoken
 * word must match some name word; among candidates, the best coverage
 * of the name wins, shortest name breaking ties.
 */
import {
  RIBBON_COMMAND_LABELS,
  RIBBON_COMMAND_ALIASES,
  type RibbonCommandId,
} from '../ribbon-commands.js';
import { normalizeWord } from './align.js';

function wordDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > 3) return 1;
  let prev = Array.from({ length: b.length + 1 }, (_v, j) => j);
  let curr = new Array<number>(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      curr[j] = Math.min(
        (prev[j] as number) + 1,
        (curr[j - 1] as number) + 1,
        (prev[j - 1] as number) + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    [prev, curr] = [curr, prev];
  }
  return (prev[b.length] as number) / Math.max(a.length, b.length);
}

const MAX_WORD_DISTANCE = 0.34;

interface NameEntry {
  id: RibbonCommandId;
  label: string;
  words: string[];
}

let entries: NameEntry[] | null = null;

function nameEntries(): NameEntry[] {
  if (entries) return entries;
  entries = [];
  for (const id of Object.keys(RIBBON_COMMAND_LABELS) as RibbonCommandId[]) {
    const label = RIBBON_COMMAND_LABELS[id];
    const names = [label, ...(RIBBON_COMMAND_ALIASES[id] ?? [])];
    for (const name of names) {
      const words = name.split(/\s+/).map(normalizeWord).filter(Boolean);
      if (words.length) entries.push({ id, label, words });
    }
  }
  return entries;
}

/** All registry name text, for the recognizer's vocabulary. */
export function commandNameVocabulary(): string {
  return nameEntries()
    .map((e) => e.words.join(' '))
    .join('\n');
}

export function matchCommandName(
  spokenName: string,
): { id: RibbonCommandId; label: string } | null {
  const spoken = spokenName.split(/\s+/).map(normalizeWord).filter(Boolean);
  if (!spoken.length) return null;

  let best: { entry: NameEntry; score: number } | null = null;
  for (const entry of nameEntries()) {
    const used = new Set<number>();
    let matched = 0;
    for (const sw of spoken) {
      let bestJ = -1;
      let bestD = MAX_WORD_DISTANCE + 1e-9;
      entry.words.forEach((w, j) => {
        if (used.has(j)) return;
        const d = wordDistance(sw, w);
        if (d < bestD) {
          bestD = d;
          bestJ = j;
        }
      });
      if (bestJ < 0) {
        matched = -1;
        break;
      }
      used.add(bestJ);
      matched++;
    }
    // Every spoken word must land; rank by coverage of the name, then
    // by shorter names (prefer "Shrink Card Text" over a longer name
    // both covering the same words).
    if (matched !== spoken.length) continue;
    const score = matched / entry.words.length - entry.words.length / 100;
    if (!best || score > best.score) best = { entry, score };
  }
  return best ? { id: best.entry.id, label: best.entry.label } : null;
}
