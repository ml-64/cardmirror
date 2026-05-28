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
 *   - `c ` → search ribbon commands only
 *   - `s ` → search settings (top-level tabs + individual settings);
 *            selecting one opens that tab and scrolls to the setting
 *   - `f ` → search `.cmir` files under the configured root. Enter
 *            opens a file; Tab dives INTO the selected file (clearing
 *            the bar) to search its objects (blocks / tags / cites);
 *            Esc from there returns to the file list with the prior
 *            query restored. Selecting an object inserts it.
 *   - no prefix → search EVERYTHING, but show nothing until the user
 *     types a query
 * With a prefix present, an empty query browses that source.
 *
 * Insertion reuses `insertSpeechSlice`; the mid-text confirm is gated
 * on the `quickCardSkipMidTextInsertConfirm` setting.
 *
 * Also exports `openQuickCardTagPicker` — the ribbon Tag Picker
 * dropdown — which edits the same global active-tags filter.
 */

import type { EditorView } from 'prosemirror-view';
import { Slice, type Node as PMNode } from 'prosemirror-model';
import { undo, redo } from 'prosemirror-history';
import { icon } from './icons';
import { schema } from '../schema/index.js';
import { settings, SETTING_METADATA, type SettingsCategory } from './settings.js';
import { openSettings, CATEGORY_TABS, type SettingsTarget } from './settings-ui.js';
import { getHost, getElectronHost } from './host/index.js';
import { showToast } from './toast.js';
import { insertSpeechSlice } from './speech-doc-send.js';
import { quickCardsStore, distinctTags, normalizeTag } from './quick-cards-store.js';
import { dropzoneStore } from './dropzone-store.js';
import { searchQuickCards } from './quick-cards-match.js';
import { parseNative } from '../native/index.js';
import {
  extractFile,
  searchFiles,
  searchFileObjects,
  baseName,
  dirName,
  FILE_OBJECT_KIND_BADGES,
  type FileEntry,
  type FileObject,
  type FileObjectKind,
  type OutlineEntry,
} from './file-search.js';
import { toggleManualPin, recordUsage, effectivePins } from './pins-store.js';
import { listRecents } from './recents-store.js';

/** Warm cache of parsed pinned files — module-level so it survives the
 *  palette opening/closing within a session (only cleared on reload).
 *  Keyed by path; `mtimeMs` is the freshness key, `enabledSig` lets a
 *  change to the searchable-object set re-extract from the cached doc
 *  without re-parsing. */
interface WarmEntry {
  mtimeMs: number;
  enabledSig: string;
  doc: PMNode;
  objects: FileObject[];
  outline: OutlineEntry[];
}
const warmCache = new Map<string, WarmEntry>();
import {
  RIBBON_COMMAND_IDS,
  RIBBON_COMMAND_LABELS,
  DEFAULT_RIBBON_KEYS,
  formatKeyForDisplay,
  type RibbonCommandId,
} from './ribbon-commands.js';

export interface QuickCardSearchOptions {
  view: EditorView | null;
  paneEl: HTMLElement | null;
  /** Trigger a ribbon command by id (the palette's command source). */
  runCommand: (id: RibbonCommandId) => void;
  /** Open a `.cmir` file by absolute path (the file source's Enter). */
  openFilePath: (path: string, name: string) => void;
}

/** A unified palette row — a quick card, dropzone item, command,
 *  settings shortcut, a file, or an object within a file. */
interface PaletteResult {
  source: 'quickcard' | 'dropzone' | 'command' | 'settings' | 'file' | 'fileobject';
  name: string;
  /** Right-aligned secondary text: card tags / command keybinding /
   *  the settings tab / the file's subfolder / a cite's owning tag. */
  meta: string;
  matchedName: boolean;
  snippet: string | null;
  /** Insert payload (quickcard / dropzone / fileobject). */
  sliceJson?: unknown;
  /** Command to run (command source). */
  commandId?: RibbonCommandId;
  /** Settings deep-link (settings source). */
  settingsTarget?: SettingsTarget;
  /** Absolute path to open (file source). */
  filePath?: string;
  /** File's mtime — the warm-cache freshness key (file source). */
  fileMtimeMs?: number;
  /** Whether this file is pinned (file source) — drives ★ + sort. */
  pinned?: boolean;
  /** Object kind, for the badge (fileobject source). */
  fileObjectKind?: FileObjectKind;
  /** Doc range to slice from the dived-into file on insert (fileobject
   *  source) — lazy, so no slice is built until you actually insert. */
  fileRange?: { from: number; to: number };
  /** Outline depth (1-4) for indentation in the nav-pane-style browse. */
  indentLevel?: number;
  /** Index into `inFile.outline` (outline browse rows only) — the key
   *  for collapse toggling. */
  outlineIndex?: number;
  /** Outline row has descendants and so can be collapsed/expanded. */
  collapsible?: boolean;
  /** Outline row is currently collapsed (children hidden). */
  collapsed?: boolean;
}

type Prefix = 'q' | 'd' | 'c' | 's' | 'f' | null;

function activeTagSet(): Set<string> {
  return new Set(settings.get('quickCardActiveTags').map(normalizeTag));
}

/** Split a leading single-letter prefix (`q `/`d `/`c `/`s `) off the query. */
function parsePrefix(raw: string): { prefix: Prefix; query: string } {
  const m = raw.match(/^([a-zA-Z])\s+(.*)$/);
  if (m) {
    const p = m[1]!.toLowerCase();
    if (p === 'q' || p === 'd' || p === 'c' || p === 's' || p === 'f')
      return { prefix: p, query: m[2]! };
  }
  return { prefix: null, query: raw };
}

function searchQuickCardSource(query: string): PaletteResult[] {
  return searchQuickCards(quickCardsStore.list(), query, activeTagSet()).map((r) => ({
    source: 'quickcard' as const,
    name: r.card.name,
    meta: r.card.tags.join(', '),
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
      meta: '',
      matchedName: true,
      snippet: null,
      sliceJson: it.sliceJson,
    }));
}

/** The current display keybinding for a command (first binding), or ''. */
function commandKeyDisplay(id: RibbonCommandId): string {
  const spec = settings.get('ribbonKeyOverrides')[id] ?? DEFAULT_RIBBON_KEYS[id];
  const first = Array.isArray(spec) ? spec[0] : spec;
  return first ? formatKeyForDisplay(first) : '';
}

/** Command source — any ribbon command (everything bindable), matched
 *  on its label; triggers the command on Enter. */
function searchCommandSource(query: string): PaletteResult[] {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  const matched =
    tokens.length === 0
      ? [...RIBBON_COMMAND_IDS]
      : RIBBON_COMMAND_IDS.filter((id) => {
          const label = RIBBON_COMMAND_LABELS[id].toLowerCase();
          return tokens.every((t) => label.includes(t));
        });
  const t0 = tokens[0];
  matched.sort((a, b) => {
    const la = RIBBON_COMMAND_LABELS[a].toLowerCase();
    const lb = RIBBON_COMMAND_LABELS[b].toLowerCase();
    if (t0) {
      const d = la.indexOf(t0) - lb.indexOf(t0);
      if (d !== 0) return d;
    }
    return la.localeCompare(lb);
  });
  return matched.map((id) => ({
    source: 'command' as const,
    name: RIBBON_COMMAND_LABELS[id],
    meta: commandKeyDisplay(id),
    matchedName: true,
    snippet: null,
    commandId: id,
  }));
}

/** Whether the dropzone is on — gates its `d` prefix, hint, and
 *  inclusion in everything-search (mirrors the pill's visibility). */
const dropzoneOn = (): boolean => settings.get('showDropzonePill');

const categoryLabel = (id: SettingsCategory): string =>
  CATEGORY_TABS.find((c) => c.id === id)?.label ?? '';

/** Settings source — top-level tabs AND individual settings, matched on
 *  label. Selecting a tab opens it; selecting a setting opens its tab
 *  and scrolls to the row. Electron-only settings are hidden off
 *  Electron so the palette never offers a row that won't render. */
function searchSettingsSource(query: string): PaletteResult[] {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  const match = (label: string): boolean =>
    tokens.length === 0 || tokens.every((t) => label.toLowerCase().includes(t));

  // Top-level tabs first.
  const results: PaletteResult[] = CATEGORY_TABS.filter(({ label }) => match(label)).map(
    ({ id, label }) => ({
      source: 'settings' as const,
      name: label,
      meta: 'Section',
      matchedName: true,
      snippet: null,
      settingsTarget: { category: id },
    }),
  );

  // Then individual settings, ranked by where the first token hits.
  const hostKind = getHost().kind;
  const items = SETTING_METADATA.filter(
    (m) => (!m.electronOnly || hostKind === 'electron') && match(m.label),
  );
  const t0 = tokens[0];
  items.sort((a, b) => {
    if (t0) {
      const d = a.label.toLowerCase().indexOf(t0) - b.label.toLowerCase().indexOf(t0);
      if (d !== 0) return d;
    }
    return a.label.localeCompare(b.label);
  });
  for (const m of items) {
    results.push({
      source: 'settings',
      name: m.label,
      meta: categoryLabel(m.category),
      matchedName: true,
      snippet: null,
      settingsTarget: { category: m.category, settingKey: m.key },
    });
  }
  return results;
}

function fileResult(f: FileEntry, pinned: boolean): PaletteResult {
  return {
    source: 'file',
    name: f.name,
    meta: dirName(f.relPath),
    matchedName: true,
    snippet: null,
    filePath: f.path,
    fileMtimeMs: f.mtimeMs,
    pinned,
  };
}

function fileObjectResult(o: FileObject): PaletteResult {
  return {
    source: 'fileobject',
    name: o.label,
    meta: o.detail,
    matchedName: true,
    snippet: null,
    fileRange: { from: o.from, to: o.to },
    fileObjectKind: o.kind,
  };
}

/** Short left-aligned badge for a result row. */
function badgeText(r: PaletteResult): string {
  switch (r.source) {
    case 'quickcard':
      return 'QC';
    case 'dropzone':
      return 'DZ';
    case 'command':
      return 'CMD';
    case 'settings':
      return 'SET';
    case 'file':
      return 'FILE';
    case 'fileobject':
      return r.fileObjectKind ? FILE_OBJECT_KIND_BADGES[r.fileObjectKind] : 'OBJ';
  }
}

/** Sources whose Enter inserts a slice (and so support Alt+Enter "at end"). */
function isInsertSource(source: PaletteResult['source']): boolean {
  return source === 'quickcard' || source === 'dropzone' || source === 'fileobject';
}

/** Verb for the Enter hint, given the selected result's source. */
function enterVerb(source: PaletteResult['source']): string {
  switch (source) {
    case 'command':
      return 'run';
    case 'settings':
      return 'open';
    case 'file':
      return 'open';
    default:
      return 'insert';
  }
}

const SEARCH_PLACEHOLDER = 'Search…';

class QuickCardSearchUI {
  private root: HTMLDivElement | null = null;
  private input!: HTMLInputElement;
  private resultsEl!: HTMLDivElement;
  private tagFilterEl!: HTMLDivElement;
  private hintsEl!: HTMLDivElement;
  private unsubscribe: (() => void) | null = null;
  private view: EditorView | null = null;
  private paneEl: HTMLElement | null = null;
  private runCommand: (id: RibbonCommandId) => void = () => {};
  private openFilePath: (path: string, name: string) => void = () => {};

  private results: PaletteResult[] = [];
  private selected = 0;
  private emptyText = '';

  // ── File-search state (the `f` prefix) ──────────────────────────────
  /** Recursive `.cmir` listing, cached for one palette session. */
  private fileList: FileEntry[] | null = null;
  private fileListLoading = false;
  /** True while the background pre-warm pass is parsing pinned files. */
  private warming = false;
  /** Monotonic guard so a stale async (list / read) result from a
   *  prior query or a closed palette is ignored. */
  private asyncToken = 0;
  /** Set while diving into a file (Tab). Overrides prefix parsing: an
   *  empty query browses `outline` (nav-pane style), a non-empty query
   *  searches `objects`; Esc restores `savedQuery`. The parsed `doc` is
   *  kept so inserts slice lazily (no per-object slice held up front). */
  private inFile: {
    path: string;
    name: string;
    doc: PMNode;
    objects: FileObject[];
    outline: OutlineEntry[];
    /** Indices into `outline` whose children are collapsed (hidden). */
    collapsedIdx: Set<number>;
    savedQuery: string;
  } | null = null;

  open(opts: QuickCardSearchOptions): void {
    // Re-triggering the open hotkey while open toggles it closed.
    if (this.root) {
      this.close();
      return;
    }
    this.view = opts.view;
    this.paneEl = opts.paneEl;
    this.runCommand = opts.runCommand;
    this.openFilePath = opts.openFilePath;
    this.fileList = null;
    this.fileListLoading = false;
    this.inFile = null;

    const root = document.createElement('div');
    root.className = 'pmd-qcs';
    root.innerHTML = `
      <div class="pmd-qcs-results" role="listbox"></div>
      <div class="pmd-qcs-tagfilter" hidden></div>
      <input class="pmd-qcs-input" type="text" spellcheck="false" autocomplete="off"
             placeholder="${SEARCH_PLACEHOLDER}" aria-label="Search" />
      <div class="pmd-qcs-hints"></div>`;
    this.root = root;
    this.resultsEl = root.querySelector('.pmd-qcs-results')!;
    this.tagFilterEl = root.querySelector('.pmd-qcs-tagfilter')!;
    this.input = root.querySelector('.pmd-qcs-input')!;
    this.hintsEl = root.querySelector('.pmd-qcs-hints')!;

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
    this.asyncToken++; // invalidate any in-flight list / read
    this.fileList = null;
    this.inFile = null;
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
    // While diving in a file, route undo/redo to the editor so a just-
    // inserted block can be taken back without leaving the bar (matches
    // the editor's own Mod-z / Mod-Shift-z / Mod-y bindings). Focus stays
    // in the input — view.dispatch doesn't steal it.
    if (this.inFile && this.view && (e.metaKey || e.ctrlKey)) {
      const k = e.key.toLowerCase();
      if (k === 'z' && !e.shiftKey) {
        e.preventDefault();
        undo(this.view.state, this.view.dispatch);
        return;
      }
      if ((k === 'z' && e.shiftKey) || k === 'y') {
        e.preventDefault();
        redo(this.view.state, this.view.dispatch);
        return;
      }
    }
    // Alt+P pins / unpins the selected file (keeps it warm).
    if (e.altKey && e.key.toLowerCase() === 'p') {
      const sel = this.results[this.selected];
      if (sel?.source === 'file' && sel.filePath) {
        e.preventDefault();
        this.togglePinPath(sel.filePath);
        return;
      }
    }
    switch (e.key) {
      case 'Escape':
        e.preventDefault();
        if (this.inFile) this.exitInFile();
        else this.close();
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
        // Stop the Enter from bubbling to `document`: activating a
        // command can synchronously open a modal (e.g. New Speech
        // Document → promptForText) that registers a document keydown
        // listener, which would otherwise catch this very Enter and
        // instantly dismiss itself.
        e.stopPropagation();
        this.activateSelected(e.altKey);
        break;
      case 'Tab':
        e.preventDefault();
        // In-file mode: Tab is a no-op (already searching within a file).
        if (this.inFile) break;
        // A selected file (file prefix OR everything search) → dive in.
        if (this.results[this.selected]?.source === 'file') {
          void this.enterInFile();
          break;
        }
        // Otherwise: the quick-card tag filter.
        this.openTagFilter();
        break;
    }
  };

  // ── Search + results ──────────────────────────────────────────────

  private runSearch(): void {
    // In-file mode overrides prefix parsing — the raw query searches
    // the dived-into file's objects.
    if (this.inFile) {
      const query = this.input.value;
      if (query.trim() === '') {
        // Empty query → the file's outline (nav-pane-style hierarchy):
        // indented by level, collapsible, shown in full (no 50-cap).
        // Cites never appear here — they aren't headings — so the
        // overview isn't doubled; they surface once you type a query.
        this.results = this.buildOutlineResults();
        this.emptyText = 'No headings in this file.';
        this.selected = 0;
        this.renderResults();
        return;
      }
      this.results = searchFileObjects(this.inFile.objects, query).map(fileObjectResult);
      this.emptyText = this.inFile.objects.length
        ? 'No matching objects in this file.'
        : 'No searchable objects in this file.';
      this.finishSearch();
      return;
    }
    const { prefix, query } = parsePrefix(this.input.value);
    if (prefix === 'f') {
      this.runFileSearch(query);
      return;
    }
    if (prefix === 'q') {
      this.results = searchQuickCardSource(query);
      this.emptyText = quickCardsStore.list().length
        ? 'No matching quick cards.'
        : 'No quick cards yet.';
    } else if (prefix === 'd') {
      if (!dropzoneOn()) {
        this.results = [];
        this.emptyText = 'The dropzone is off — turn it on in Settings → Appearance.';
      } else {
        this.results = searchDropzoneSource(query);
        this.emptyText = dropzoneStore.list().length
          ? 'No matching dropzone items.'
          : 'The dropzone is empty.';
      }
    } else if (prefix === 'c') {
      this.results = searchCommandSource(query);
      this.emptyText = 'No matching commands.';
    } else if (prefix === 's') {
      this.results = searchSettingsSource(query);
      this.emptyText = 'No matching settings.';
    } else if (query.trim() === '') {
      // No prefix, nothing typed — don't preview anything. The `d
      // dropzone` hint only shows when the dropzone is on.
      this.results = [];
      this.emptyText = `Type to search everything · c commands${
        dropzoneOn() ? ' · d dropzone' : ''
      } · f files · q cards · s settings`;
    } else {
      // No prefix — search everything. Files (by filename) join the
      // other sources; the recursive `.cmir` scan is kicked off lazily
      // and cached, so the first everything-search after opening may
      // show non-file results first and fold files in once the scan
      // finishes (loadFileList re-runs the search on completion). The
      // dropzone is included only when it's on.
      this.ensureFileList();
      const filePins = this.fileList ? this.manualPinPaths() : null;
      this.results = [
        ...searchQuickCardSource(query),
        ...(dropzoneOn() ? searchDropzoneSource(query) : []),
        ...searchCommandSource(query),
        ...searchSettingsSource(query),
        ...(this.fileList && filePins
          ? searchFiles(this.fileList, query).map((f) => fileResult(f, filePins.has(f.path)))
          : []),
      ];
      this.emptyText = 'No matches.';
    }
    this.finishSearch();
  }

  /** Clamp, reset selection, render — the shared tail of every search. */
  private finishSearch(): void {
    this.results = this.results.slice(0, 50);
    this.selected = 0;
    this.renderResults();
  }

  // ── File search (`f` prefix) ──────────────────────────────────────

  private runFileSearch(query: string): void {
    const electron = getElectronHost();
    if (!electron) {
      this.results = [];
      this.emptyText = 'File search needs the desktop app.';
      this.finishSearch();
      return;
    }
    const root = settings.get('fileSearchRoot');
    if (!root) {
      this.results = [];
      this.emptyText = 'Set a file-search folder in Settings → General.';
      this.finishSearch();
      return;
    }
    if (this.fileList === null) {
      if (!this.fileListLoading) this.loadFileList(root, electron);
      this.results = [];
      this.emptyText = 'Searching files…';
      this.finishSearch();
      return;
    }
    // ★ + top-sort reflect MANUAL pins (the user-controlled feature);
    // auto pins (recents/frequents) are warmed silently, not surfaced.
    const pins = this.manualPinPaths();
    const matched = searchFiles(this.fileList, query);
    const ordered = [
      ...matched.filter((f) => pins.has(f.path)),
      ...matched.filter((f) => !pins.has(f.path)),
    ];
    this.results = ordered.map((f) => fileResult(f, pins.has(f.path)));
    this.emptyText = this.fileList.length
      ? 'No matching files.'
      : 'No .cmir files in the search folder.';
    this.finishSearch();
  }

  /** Manually-pinned paths (★ + top-sort). `autoEnabled: false` makes
   *  `effectivePins` return just the manual set. */
  private manualPinPaths(): Set<string> {
    return effectivePins([], false);
  }

  /** Paths that should be kept warm: manual pins always, plus the auto
   *  set (recents ∪ frequents) when the auto-pin setting is on. */
  private effectivePinPaths(): Set<string> {
    const recentPaths = listRecents()
      .map((r) => r.handle)
      .filter((h): h is string => typeof h === 'string' && h.length > 0);
    return effectivePins(recentPaths, settings.get('pinAutoEnabled'));
  }

  private enabledSet(): Set<FileObjectKind> {
    return new Set(settings.get('fileSearchObjectTypes') as FileObjectKind[]);
  }

  private enabledSig(): string {
    return (settings.get('fileSearchObjectTypes') as string[]).slice().sort().join(',');
  }

  /** Drop warm entries for files that are no longer pinned. */
  private pruneWarm(pins: Set<string>): void {
    for (const key of [...warmCache.keys()]) {
      if (!pins.has(key)) warmCache.delete(key);
    }
  }

  /** Background pass: parse pinned files that aren't warm yet (or are
   *  stale by mtime), sequentially so it yields. Prunes rotated-out
   *  pins first. Cheap on repeat opens — already-warm files are skipped. */
  private async warmPins(): Promise<void> {
    if (this.warming) return;
    const electron = getElectronHost();
    if (!electron || !this.fileList) return;
    this.warming = true;
    try {
      const pins = this.effectivePinPaths();
      this.pruneWarm(pins);
      const byPath = new Map(this.fileList.map((f) => [f.path, f]));
      for (const path of pins) {
        if (!this.root) break; // palette closed
        const entry = byPath.get(path);
        if (!entry) continue; // not under the search root → unknown mtime
        const warm = warmCache.get(path);
        if (warm && warm.mtimeMs === entry.mtimeMs) continue; // fresh
        try {
          const file = await electron.readFileAtPath(path);
          if (!file) continue;
          const doc = parseNative(file.bytes).doc;
          const { objects, outline } = extractFile(doc, this.enabledSet());
          warmCache.set(path, { mtimeMs: entry.mtimeMs, enabledSig: this.enabledSig(), doc, objects, outline });
        } catch {
          /* unreadable / not a valid .cmir — skip */
        }
      }
    } finally {
      this.warming = false;
    }
  }

  /** Toggle a file's manual pin, keeping it selected and re-warming. */
  private togglePinPath(path: string): void {
    toggleManualPin(path);
    this.runSearch(); // re-sort + refresh ★
    const at = this.results.findIndex((r) => r.filePath === path);
    if (at >= 0) {
      this.selected = at;
      this.renderResults();
    }
    void this.warmPins();
  }

  /** Kick off the (cached, once-per-session) file scan if it hasn't run
   *  yet — used by the no-prefix everything search, which folds files in
   *  once the scan completes. No-op without an Electron host + a root. */
  private ensureFileList(): void {
    if (this.fileList !== null || this.fileListLoading) return;
    const electron = getElectronHost();
    const root = settings.get('fileSearchRoot');
    if (!electron || !root) return;
    this.loadFileList(root, electron);
  }

  /** Recursively list `.cmir` files under `root` once per session; on
   *  completion re-run the search (if still open + still in file mode). */
  private loadFileList(root: string, electron: NonNullable<ReturnType<typeof getElectronHost>>): void {
    this.fileListLoading = true;
    const token = ++this.asyncToken;
    void electron
      .listCmirFiles(root)
      .then((list) => {
        if (token !== this.asyncToken || !this.root) return;
        this.fileList = list.map((it) => ({
          path: it.path,
          relPath: it.relPath,
          name: baseName(it.relPath),
          mtimeMs: it.mtimeMs,
        }));
        this.fileListLoading = false;
        if (!this.inFile) this.runSearch();
        void this.warmPins(); // pre-warm pinned files in the background
      })
      .catch(() => {
        if (token !== this.asyncToken || !this.root) return;
        this.fileList = [];
        this.fileListLoading = false;
        if (!this.inFile) this.runSearch();
      });
  }

  /** Tab from a selected file → enter in-file mode with the bar cleared.
   *  Uses the warm cache when the file is pinned + fresh (instant); else
   *  reads + parses, warming it if it's pinned. Records usage either way. */
  private async enterInFile(): Promise<void> {
    const sel = this.results[this.selected];
    if (!sel || sel.source !== 'file' || !sel.filePath) return;
    const electron = getElectronHost();
    if (!electron) return;
    const path = sel.filePath;
    const name = sel.name;
    const mtimeMs = sel.fileMtimeMs ?? 0;
    const savedQuery = this.input.value;
    recordUsage(path);

    // Warm hit — no read/parse. Re-extract from the cached doc only if
    // the searchable-object set changed since it was warmed.
    const warm = warmCache.get(path);
    if (warm && warm.mtimeMs === mtimeMs) {
      if (warm.enabledSig !== this.enabledSig()) {
        const re = extractFile(warm.doc, this.enabledSet());
        warm.objects = re.objects;
        warm.outline = re.outline;
        warm.enabledSig = this.enabledSig();
      }
      this.mountInFile(path, name, warm.doc, warm.objects, warm.outline, savedQuery);
      return;
    }

    // Cold — read + parse + extract.
    this.results = [];
    this.emptyText = `Opening "${name}"…`;
    this.finishSearch();
    const token = ++this.asyncToken;
    let doc: PMNode;
    let objects: FileObject[];
    let outline: OutlineEntry[];
    try {
      const file = await electron.readFileAtPath(path);
      if (!file) throw new Error('read failed');
      doc = parseNative(file.bytes).doc;
      ({ objects, outline } = extractFile(doc, this.enabledSet()));
    } catch {
      if (token !== this.asyncToken || !this.root) return;
      showToast(`Couldn't read "${name}".`);
      this.runSearch(); // stay in file mode
      return;
    }
    if (token !== this.asyncToken || !this.root) return;
    // Keep it warm if this file is pinned.
    if (mtimeMs && this.effectivePinPaths().has(path)) {
      warmCache.set(path, { mtimeMs, enabledSig: this.enabledSig(), doc, objects, outline });
      this.pruneWarm(this.effectivePinPaths());
    }
    this.mountInFile(path, name, doc, objects, outline, savedQuery);
  }

  /** Enter in-file mode with an already-extracted file: seed the
   *  collapsed set from the default depth, clear the bar, render. */
  private mountInFile(
    path: string,
    name: string,
    doc: PMNode,
    objects: FileObject[],
    outline: OutlineEntry[],
    savedQuery: string,
  ): void {
    // Headings at or deeper than the default depth start collapsed
    // (depth 3 → blocks closed), mirroring the nav pane's default depth.
    const depth = settings.get('fileSearchOutlineDepth');
    const collapsedIdx = new Set<number>();
    outline.forEach((e, i) => {
      if (e.level >= depth) collapsedIdx.add(i);
    });
    this.inFile = { path, name, doc, objects, outline, collapsedIdx, savedQuery };
    this.input.value = '';
    this.input.placeholder = `Search in ${name}…`;
    this.runSearch();
  }

  /** Visible outline rows for the browse — walks `outline` honoring the
   *  collapsed set (a collapsed heading hides everything under it until
   *  the next equal-or-shallower heading). Each row carries its outline
   *  index + collapsible / collapsed flags for the chevron + toggle. */
  private buildOutlineResults(): PaletteResult[] {
    if (!this.inFile) return [];
    const { outline, collapsedIdx } = this.inFile;
    const out: PaletteResult[] = [];
    let hideBelow = Infinity; // hide entries with level > hideBelow
    outline.forEach((e, i) => {
      if (e.level <= hideBelow) hideBelow = Infinity; // left the collapsed subtree
      if (hideBelow !== Infinity) return; // still hidden
      const next = outline[i + 1];
      const collapsible = e.level <= 3 && !!next && next.level > e.level;
      const collapsed = collapsedIdx.has(i);
      out.push({
        source: 'fileobject',
        name: e.label || '(untitled)',
        meta: '',
        matchedName: true,
        snippet: null,
        fileRange: { from: e.from, to: e.to },
        fileObjectKind: e.kind,
        indentLevel: e.level,
        outlineIndex: i,
        collapsible,
        collapsed,
      });
      if (collapsible && collapsed) hideBelow = e.level;
    });
    return out;
  }

  /** Toggle a heading's collapsed state (right-click / chevron), keeping
   *  the toggled row selected. */
  private toggleOutlineCollapse(outlineIndex: number): void {
    if (!this.inFile) return;
    const set = this.inFile.collapsedIdx;
    if (set.has(outlineIndex)) set.delete(outlineIndex);
    else set.add(outlineIndex);
    this.results = this.buildOutlineResults();
    const at = this.results.findIndex((r) => r.outlineIndex === outlineIndex);
    this.selected = at >= 0 ? at : Math.min(this.selected, this.results.length - 1);
    this.renderResults();
  }

  /** Esc from in-file mode → back to the file list, restoring the query. */
  private exitInFile(): void {
    if (!this.inFile) return;
    const { savedQuery } = this.inFile;
    this.inFile = null;
    this.input.placeholder = SEARCH_PLACEHOLDER;
    this.input.value = savedQuery;
    this.runSearch();
  }

  private move(delta: number): void {
    if (this.results.length === 0) return;
    this.selected = (this.selected + delta + this.results.length) % this.results.length;
    this.renderResults();
  }

  /** Bottom hint strip — reflects what Enter / Alt+Enter / Tab / Esc
   *  actually do given the current mode and the selected result. */
  private renderHints(): void {
    const sel = this.results[this.selected];
    const inFile = !!this.inFile;
    const segs: string[] = [];

    if (this.results.length > 0) segs.push('↑↓ navigate');
    if (sel) {
      segs.push(`↵ ${enterVerb(sel.source)}`);
      // Alt+Enter (insert at end of doc) only applies to inserts.
      if (isInsertSource(sel.source)) segs.push('⌥↵ at end');
    }
    // Tab: dive into a selected file, else open the tag filter — and
    // nothing while already inside a file.
    if (!inFile) {
      segs.push(sel?.source === 'file' ? '⇥ search inside' : '⇥ tags');
    }
    if (sel?.source === 'file') segs.push(sel.pinned ? 'alt+p unpin' : 'alt+p pin');
    // Outline browse (in-file, empty query) → mention collapse.
    if (inFile && this.input.value.trim() === '' && this.results.some((r) => r.collapsible)) {
      segs.push('right-click: expand/collapse');
    }
    segs.push(inFile ? 'esc back to files' : 'esc close');

    this.hintsEl.replaceChildren(
      ...segs.map((s) => {
        const span = document.createElement('span');
        span.textContent = s;
        return span;
      }),
    );
  }

  private renderResults(): void {
    this.renderHints();
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
      // Outline browse: indent by heading depth for a nav-pane look.
      if (r.indentLevel) {
        row.style.paddingLeft = `${0.5 + (r.indentLevel - 1) * 1}rem`;
      }
      const top = document.createElement('div');
      top.className = 'pmd-qcs-row-top';
      // Outline rows get a collapse chevron (collapsible) or a spacer
      // (to keep labels aligned). Right-click the row also toggles.
      if (r.indentLevel !== undefined) {
        const twisty = document.createElement('span');
        twisty.className = 'pmd-qcs-twisty';
        if (r.collapsible) {
          twisty.classList.add('pmd-qcs-twisty-btn');
          twisty.appendChild(icon(r.collapsed ? 'chevron-right' : 'chevron-down'));
          twisty.addEventListener('click', (ev) => {
            ev.stopPropagation();
            if (r.outlineIndex !== undefined) this.toggleOutlineCollapse(r.outlineIndex);
          });
        }
        top.appendChild(twisty);
        row.addEventListener('contextmenu', (ev) => {
          ev.preventDefault();
          if (r.collapsible && r.outlineIndex !== undefined) {
            this.toggleOutlineCollapse(r.outlineIndex);
          }
        });
      }
      const badge = document.createElement('span');
      badge.className = `pmd-qcs-row-badge pmd-qcs-badge-${r.source}`;
      badge.textContent = badgeText(r);
      top.appendChild(badge);
      const name = document.createElement('span');
      name.className = 'pmd-qcs-row-name';
      name.textContent = r.name;
      top.appendChild(name);
      if (r.meta) {
        const meta = document.createElement('span');
        meta.className = 'pmd-qcs-row-tags';
        meta.textContent = r.meta;
        top.appendChild(meta);
      }
      // Pin star on file rows — filled when pinned, faint otherwise.
      // The star, and right-clicking the row, both toggle the pin.
      if (r.source === 'file' && r.filePath) {
        const path = r.filePath;
        const star = document.createElement('span');
        star.className = r.pinned ? 'pmd-qcs-star pmd-qcs-star-on' : 'pmd-qcs-star';
        star.textContent = '★';
        star.title = r.pinned ? 'Unpin' : 'Pin (keep warm)';
        star.addEventListener('click', (ev) => {
          ev.stopPropagation();
          this.togglePinPath(path);
        });
        top.appendChild(star);
        row.addEventListener('contextmenu', (ev) => {
          ev.preventDefault();
          this.togglePinPath(path);
        });
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
        this.activateSelected(false);
      });
      this.resultsEl.appendChild(row);
    });
    this.resultsEl.querySelector('.pmd-qcs-row-active')?.scrollIntoView({ block: 'nearest' });
  }

  // ── Insert ────────────────────────────────────────────────────────

  private activateSelected(atEnd: boolean): void {
    const result = this.results[this.selected];
    if (!result) return;
    // Commands: close the palette, then run the command (it acts on the
    // editor with focus restored). atEnd is irrelevant for commands.
    if (result.source === 'command') {
      const id = result.commandId!;
      this.close();
      this.runCommand(id);
      return;
    }
    // Settings: close the palette, then open the dialog to the tab and
    // scroll to the setting. atEnd is irrelevant.
    if (result.source === 'settings') {
      const target = result.settingsTarget;
      this.close();
      openSettings(target);
      return;
    }
    // File: close the palette, then open the document. atEnd irrelevant.
    if (result.source === 'file') {
      const path = result.filePath;
      const name = result.name;
      if (path) recordUsage(path); // counts toward "frequents"
      this.close();
      if (path) this.openFilePath(path, name);
      return;
    }
    // Everything else (quickcard / dropzone / fileobject) inserts a slice.
    const view = this.view;
    if (!view || !view.editable) {
      showToast('No editable document to insert into.');
      return;
    }
    let slice: Slice;
    try {
      if (result.source === 'fileobject' && result.fileRange && this.inFile) {
        // Slice lazily from the kept parsed doc (no per-object slice held).
        slice = this.inFile.doc.slice(result.fileRange.from, result.fileRange.to);
      } else {
        slice = Slice.fromJSON(schema, result.sliceJson as Parameters<typeof Slice.fromJSON>[1]);
      }
    } catch {
      showToast('That item is corrupted and can’t be inserted.');
      return;
    }
    // Inserting a within-file object keeps the palette open and the file
    // loaded so several blocks can be grabbed in a row (the file's slices
    // are already in memory — no re-parse). Everything else closes.
    //
    // The mid-text guard is a native `window.confirm`, so it can't
    // trigger the outside-click close. The disruption to guard against is
    // focus: insertSpeechSlice's deferred insert ends with a
    // `speechView.focus()`, so we re-claim the bar via `afterInsert`
    // (which also runs only on a real insert — no toast on cancel).
    const keepOpen = !!this.inFile && result.source === 'fileobject';
    if (!keepOpen) this.close();
    const name = result.name;
    insertSpeechSlice(
      view,
      slice,
      atEnd,
      keepOpen
        ? () => {
            showToast(`Inserted "${name}".`);
            this.input.focus();
          }
        : undefined,
      {
        enabled: !settings.get('quickCardSkipMidTextInsertConfirm'),
        message: 'Insert into the middle of text. Are you sure?',
      },
    );
    // Cancelling the confirm returns focus to the editor without firing
    // `afterInsert`; pull it back to the bar so a cancel still leaves you
    // ready to search again.
    if (keepOpen) this.input.focus();
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
 *  (top) match; ↑/↓ move, Enter toggles, Esc calls `onDismiss` (Tab
 *  is swallowed, not a dismiss). `onChange` fires after any toggle. */
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
        e.preventDefault();
        onDismiss();
        break;
      case 'Tab':
        // Tab no longer toggles back out — only Escape dismisses. Keeps
        // the "Tab in, Esc out" model consistent with file search; we
        // still preventDefault so focus can't escape the picker.
        e.preventDefault();
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
