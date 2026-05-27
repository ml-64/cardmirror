/**
 * Quick Cards — search palette (with the prefix system).
 *
 * A floating command-palette-style bar (see
 * `reference-docs/SPEC-quick-cards.md` §6): opens centered over the
 * target editor pane, results rendered ABOVE the bar, instant focus,
 * a one-shot blue pulse that fades.
 *
 * Prefix system (a small first slice of the eventual full set —
 * search-everything / transclude / quick cards / dropzone / index):
 *   - `q ` → search quick cards only
 *   - `d ` → search the dropzone only
 *   - no prefix → search EVERYTHING (quick cards + dropzone), but show
 *     nothing until the user types a query
 * With a prefix present, an empty query browses that source.
 *
 * Insertion reuses `insertSpeechSlice`; the mid-text confirm is gated
 * on the `quickCardSkipMidTextInsertConfirm` setting.
 *
 * Also exports `openQuickCardTagPicker` — the ribbon Tag Picker
 * dropdown — which edits the same global active-tags filter.
 */

import type { EditorView } from 'prosemirror-view';
import { Slice } from 'prosemirror-model';
import { schema } from '../schema/index.js';
import { settings } from './settings.js';
import { showToast } from './toast.js';
import { insertSpeechSlice } from './speech-doc-send.js';
import { quickCardsStore, distinctTags, normalizeTag } from './quick-cards-store.js';
import { dropzoneStore } from './dropzone-store.js';
import { searchQuickCards } from './quick-cards-match.js';

export interface QuickCardSearchOptions {
  view: EditorView | null;
  paneEl: HTMLElement | null;
}

/** A unified palette row — a quick card or a dropzone item. */
interface PaletteResult {
  source: 'quickcard' | 'dropzone';
  name: string;
  tags: string[];
  matchedName: boolean;
  snippet: string | null;
  sliceJson: unknown;
}

type Prefix = 'q' | 'd' | null;

function activeTagSet(): Set<string> {
  return new Set(settings.get('quickCardActiveTags').map(normalizeTag));
}

/** Split a leading single-letter prefix (`q `/`d `) off the query. */
function parsePrefix(raw: string): { prefix: Prefix; query: string } {
  const m = raw.match(/^([a-zA-Z])\s+(.*)$/);
  if (m) {
    const p = m[1]!.toLowerCase();
    if (p === 'q' || p === 'd') return { prefix: p, query: m[2]! };
  }
  return { prefix: null, query: raw };
}

function searchQuickCardSource(query: string): PaletteResult[] {
  return searchQuickCards(quickCardsStore.list(), query, activeTagSet()).map((r) => ({
    source: 'quickcard' as const,
    name: r.card.name,
    tags: r.card.tags,
    matchedName: r.matchedName,
    snippet: r.snippet,
    sliceJson: r.card.contentJson,
  }));
}

function searchDropzoneSource(query: string): PaletteResult[] {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  const items = dropzoneStore.list();
  const matched =
    tokens.length === 0
      ? [...items]
      : items.filter((it) => tokens.every((t) => it.label.toLowerCase().includes(t)));
  return matched
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((it) => ({
      source: 'dropzone' as const,
      name: it.label,
      tags: [],
      matchedName: true,
      snippet: null,
      sliceJson: it.sliceJson,
    }));
}

class QuickCardSearchUI {
  private root: HTMLDivElement | null = null;
  private input!: HTMLInputElement;
  private resultsEl!: HTMLDivElement;
  private tagFilterEl!: HTMLDivElement;
  private unsubscribe: (() => void) | null = null;
  private view: EditorView | null = null;
  private paneEl: HTMLElement | null = null;

  private results: PaletteResult[] = [];
  private selected = 0;
  private emptyText = '';

  open(opts: QuickCardSearchOptions): void {
    // Re-triggering the open hotkey while open toggles it closed.
    if (this.root) {
      this.close();
      return;
    }
    this.view = opts.view;
    this.paneEl = opts.paneEl;

    const root = document.createElement('div');
    root.className = 'pmd-qcs';
    root.innerHTML = `
      <div class="pmd-qcs-results" role="listbox"></div>
      <div class="pmd-qcs-tagfilter" hidden></div>
      <input class="pmd-qcs-input" type="text" spellcheck="false" autocomplete="off"
             placeholder="Search…  (q quick cards · d dropzone)" aria-label="Search" />
      <div class="pmd-qcs-hints">
        <span>↑↓ navigate</span><span>↵ insert</span><span>⌥↵ at end</span><span>⇥ tags</span><span>esc</span>
      </div>`;
    this.root = root;
    this.resultsEl = root.querySelector('.pmd-qcs-results')!;
    this.tagFilterEl = root.querySelector('.pmd-qcs-tagfilter')!;
    this.input = root.querySelector('.pmd-qcs-input')!;

    document.body.appendChild(root);
    this.reposition();
    this.input.focus();

    root.classList.add('pmd-qcs-pulse');
    root.addEventListener('animationend', () => root.classList.remove('pmd-qcs-pulse'), {
      once: true,
    });

    this.input.addEventListener('input', () => this.runSearch());
    this.input.addEventListener('keydown', this.onInputKey);
    document.addEventListener('pointerdown', this.onDocPointerDown, true);
    window.addEventListener('resize', this.onResize);
    this.unsubscribe = quickCardsStore.subscribe(() => this.runSearch());

    this.runSearch();
  }

  /** Center over the target pane and clamp the width to fit it, so the
   *  bar shrinks elegantly in narrow / multi-pane windows. Re-run on
   *  resize since panes reflow with the window. */
  private reposition(): void {
    if (!this.root) return;
    const rect = this.paneEl?.getBoundingClientRect();
    const available = rect && rect.width > 0 ? rect.width : window.innerWidth;
    const centerX = rect && rect.width > 0 ? rect.left + rect.width / 2 : window.innerWidth / 2;
    this.root.style.left = `${Math.round(centerX)}px`;
    this.root.style.width = `${Math.round(Math.max(240, Math.min(540, available - 24)))}px`;
  }

  private onResize = (): void => this.reposition();

  close(): void {
    if (!this.root) return;
    document.removeEventListener('pointerdown', this.onDocPointerDown, true);
    window.removeEventListener('resize', this.onResize);
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.root.remove();
    this.root = null;
    this.view?.focus();
  }

  isOpen(): boolean {
    return !!this.root;
  }

  private onDocPointerDown = (e: PointerEvent): void => {
    if (this.root && !this.root.contains(e.target as Node)) this.close();
  };

  private onInputKey = (e: KeyboardEvent): void => {
    switch (e.key) {
      case 'Escape':
        e.preventDefault();
        this.close();
        break;
      case 'ArrowDown':
        e.preventDefault();
        this.move(1);
        break;
      case 'ArrowUp':
        e.preventDefault();
        this.move(-1);
        break;
      case 'Enter':
        e.preventDefault();
        this.insertSelected(e.altKey);
        break;
      case 'Tab':
        e.preventDefault();
        this.openTagFilter();
        break;
    }
  };

  // ── Search + results ──────────────────────────────────────────────

  private runSearch(): void {
    const { prefix, query } = parsePrefix(this.input.value);
    if (prefix === 'q') {
      this.results = searchQuickCardSource(query);
      this.emptyText = quickCardsStore.list().length
        ? 'No matching quick cards.'
        : 'No quick cards yet.';
    } else if (prefix === 'd') {
      this.results = searchDropzoneSource(query);
      this.emptyText = dropzoneStore.list().length
        ? 'No matching dropzone items.'
        : 'The dropzone is empty.';
    } else if (query.trim() === '') {
      // No prefix, nothing typed — don't preview anything.
      this.results = [];
      this.emptyText = 'Type to search everything · q quick cards · d dropzone';
    } else {
      // No prefix — search everything (quick cards, then dropzone).
      this.results = [...searchQuickCardSource(query), ...searchDropzoneSource(query)];
      this.emptyText = 'No matches.';
    }
    this.results = this.results.slice(0, 50);
    this.selected = 0;
    this.renderResults();
  }

  private move(delta: number): void {
    if (this.results.length === 0) return;
    this.selected = (this.selected + delta + this.results.length) % this.results.length;
    this.renderResults();
  }

  private renderResults(): void {
    this.resultsEl.innerHTML = '';
    if (this.results.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'pmd-qcs-empty';
      empty.textContent = this.emptyText;
      this.resultsEl.appendChild(empty);
      return;
    }
    this.results.forEach((r, i) => {
      const row = document.createElement('div');
      row.className = 'pmd-qcs-row';
      row.setAttribute('role', 'option');
      if (i === this.selected) {
        row.classList.add('pmd-qcs-row-active');
        row.setAttribute('aria-selected', 'true');
      }
      const top = document.createElement('div');
      top.className = 'pmd-qcs-row-top';
      const badge = document.createElement('span');
      badge.className = `pmd-qcs-row-badge pmd-qcs-badge-${r.source}`;
      badge.textContent = r.source === 'quickcard' ? 'QC' : 'DZ';
      top.appendChild(badge);
      const name = document.createElement('span');
      name.className = 'pmd-qcs-row-name';
      name.textContent = r.name;
      top.appendChild(name);
      if (r.tags.length) {
        const tags = document.createElement('span');
        tags.className = 'pmd-qcs-row-tags';
        tags.textContent = r.tags.join(', ');
        top.appendChild(tags);
      }
      row.appendChild(top);
      if (!r.matchedName && r.snippet) {
        const snip = document.createElement('div');
        snip.className = 'pmd-qcs-row-snippet';
        snip.textContent = r.snippet;
        row.appendChild(snip);
      }
      row.addEventListener('mousemove', () => {
        if (this.selected !== i) {
          this.selected = i;
          this.renderResults();
        }
      });
      row.addEventListener('click', () => {
        this.selected = i;
        this.insertSelected(false);
      });
      this.resultsEl.appendChild(row);
    });
    this.resultsEl.querySelector('.pmd-qcs-row-active')?.scrollIntoView({ block: 'nearest' });
  }

  // ── Insert ────────────────────────────────────────────────────────

  private insertSelected(atEnd: boolean): void {
    const result = this.results[this.selected];
    if (!result) return;
    const view = this.view;
    if (!view || !view.editable) {
      showToast('No editable document to insert into.');
      return;
    }
    let slice: Slice;
    try {
      slice = Slice.fromJSON(schema, result.sliceJson as Parameters<typeof Slice.fromJSON>[1]);
    } catch {
      showToast('That item is corrupted and can’t be inserted.');
      return;
    }
    this.close();
    insertSpeechSlice(view, slice, atEnd, undefined, {
      enabled: !settings.get('quickCardSkipMidTextInsertConfirm'),
      message: 'Insert into the middle of text. Are you sure?',
    });
  }

  // ── Inline tag filter (Tab) ───────────────────────────────────────

  private openTagFilter(): void {
    renderTagPicker(
      this.tagFilterEl,
      () => this.runSearch(),
      () => {
        this.tagFilterEl.hidden = true;
        this.input.focus();
      },
    );
    this.tagFilterEl.hidden = false;
    this.tagFilterEl.querySelector<HTMLInputElement>('.pmd-qctags-filter')?.focus();
  }
}

export const quickCardSearchUI = new QuickCardSearchUI();

// ── Shared tag-picker (inline + ribbon dropdown) ─────────────────────

/** Render a keyboard-navigable, type-to-filter tag list into `host`,
 *  editing the global `quickCardActiveTags`. Auto-selects the best
 *  (top) match; ↑/↓ move, Enter toggles, Tab / Shift-Tab / Esc call
 *  `onDismiss`. `onChange` fires after any toggle. */
function renderTagPicker(host: HTMLElement, onChange: () => void, onDismiss: () => void): void {
  host.innerHTML = '';
  const all = distinctTags(quickCardsStore.list());
  let shown: string[] = all;
  let selected = 0;

  const filter = document.createElement('input');
  filter.type = 'text';
  filter.className = 'pmd-qctags-filter';
  filter.placeholder = 'Filter tags…';
  filter.spellcheck = false;
  filter.autocomplete = 'off';
  host.appendChild(filter);

  const list = document.createElement('div');
  list.className = 'pmd-qctags-list';
  host.appendChild(list);

  const computeShown = (): void => {
    const q = normalizeTag(filter.value);
    shown = all
      .filter((t) => (q ? normalizeTag(t).includes(q) : true))
      .sort((a, b) => {
        if (!q) return 0;
        const d = normalizeTag(a).indexOf(q) - normalizeTag(b).indexOf(q);
        return d !== 0 ? d : a.toLowerCase().localeCompare(b.toLowerCase());
      });
    selected = 0;
  };

  const renderList = (): void => {
    const active = activeTagSet();
    list.innerHTML = '';
    if (all.length === 0) {
      const none = document.createElement('div');
      none.className = 'pmd-qctags-empty';
      none.textContent = 'No tags yet.';
      list.appendChild(none);
      return;
    }
    shown.forEach((tag, i) => {
      const row = document.createElement('label');
      row.className = 'pmd-qctags-row';
      if (i === selected) row.classList.add('pmd-qctags-row-active');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.tabIndex = -1;
      cb.checked = active.has(normalizeTag(tag));
      cb.addEventListener('change', () => toggle(tag));
      const span = document.createElement('span');
      span.textContent = tag;
      row.append(cb, span);
      row.addEventListener('mousemove', () => {
        if (selected !== i) {
          selected = i;
          renderList();
        }
      });
      list.appendChild(row);
    });
    list.querySelector('.pmd-qctags-row-active')?.scrollIntoView({ block: 'nearest' });
  };

  const toggle = (tag: string): void => {
    const next = new Set(settings.get('quickCardActiveTags').map(normalizeTag));
    const n = normalizeTag(tag);
    if (next.has(n)) next.delete(n);
    else next.add(n);
    settings.set('quickCardActiveTags', [...next]);
    onChange();
    renderList();
  };

  filter.addEventListener('input', () => {
    computeShown();
    renderList();
  });
  filter.addEventListener('keydown', (e) => {
    switch (e.key) {
      case 'Escape':
      case 'Tab':
        e.preventDefault();
        onDismiss();
        break;
      case 'ArrowDown':
        e.preventDefault();
        if (shown.length) {
          selected = (selected + 1) % shown.length;
          renderList();
        }
        break;
      case 'ArrowUp':
        e.preventDefault();
        if (shown.length) {
          selected = (selected - 1 + shown.length) % shown.length;
          renderList();
        }
        break;
      case 'Enter':
        e.preventDefault();
        if (shown[selected]) toggle(shown[selected]!);
        break;
    }
  });

  const footer = document.createElement('div');
  footer.className = 'pmd-qctags-footer';
  const clear = document.createElement('button');
  clear.type = 'button';
  clear.className = 'pmd-qctags-clear';
  clear.textContent = 'Clear filter';
  clear.addEventListener('click', () => {
    settings.set('quickCardActiveTags', []);
    onChange();
    renderList();
  });
  footer.appendChild(clear);
  host.appendChild(footer);

  computeShown();
  renderList();
}

/** Ribbon Tag Picker dropdown — a standalone popover anchored under
 *  the 🏷️ button, editing the same global active-tags filter. */
export function openQuickCardTagPicker(anchorEl: HTMLElement): void {
  const existing = document.querySelector('.pmd-qctags-popover');
  if (existing) {
    existing.remove();
    return;
  }
  const pop = document.createElement('div');
  pop.className = 'pmd-qctags-popover';
  document.body.appendChild(pop);
  const rect = anchorEl.getBoundingClientRect();
  pop.style.left = `${Math.round(rect.left)}px`;
  pop.style.top = `${Math.round(rect.bottom + 4)}px`;

  const close = (): void => {
    pop.remove();
    document.removeEventListener('pointerdown', onDown, true);
  };
  const onDown = (e: PointerEvent): void => {
    if (!pop.contains(e.target as Node) && e.target !== anchorEl) close();
  };
  document.addEventListener('pointerdown', onDown, true);
  renderTagPicker(pop, () => {}, close);
  pop.querySelector<HTMLInputElement>('.pmd-qctags-filter')?.focus();
}
