/**
 * Multi-pane workspace shell.
 *
 * Mounted at boot when `settings.get('multiDocWorkspace')` is true.
 * Owns three slots (`slot1` / `slot2` / `slot3`), each holding a stack
 * of 0+ documents. Renders a per-slot pane with a small title chip,
 * the live ProseMirror EditorView, and a footer (word count + Open
 * file button). The nav pane is split into one section per active
 * slot. The shared ribbon, status bar, and Save / Save As route
 * through the focused pane via `setActiveView` in `editor/index.ts`.
 *
 * Comments are disabled in multi-doc mode (see SPEC-multi-pane.md).
 *
 * Layout cells:
 *   - 1 active slot  → full width
 *   - 2 active slots → 50/50
 *   - 3 active slots → compact (thirds) OR wide-scroll (paged)
 *
 * Cross-pane drag = copy (handled in `drag-controller.ts`'s commit
 * branch for cross-view drops). Drag from doc → another doc's nav
 * section works the same way: the destination nav section's surface
 * declares its view, the controller treats it as cross-view.
 */

import { EditorState, TextSelection } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { Node as PMNode } from 'prosemirror-model';
import { schema, newHeadingId } from '../schema/index.js';
import { fromDocxFull } from '../index.js';
import { settings } from './settings.js';
import { NavigationPanel } from './nav-panel.js';
import { EditorDragSurface } from './drag-editor-surface.js';
import { dragController, rewriteHeadingIds } from './drag-controller.js';
import { countReadAloudWords, formatReadTime, formatNumber } from './word-count.js';
import { scheduleIdle, cancelIdle, type IdleHandle } from './idle-scheduler.js';
import { getSpeechDocResolver } from './speech-doc-registry.js';
import {
  buildEditorPlugins,
  enableMultiDocMode,
  setActiveView,
  getActiveView,
  applyReadModeToTarget,
  setReadModeStateResolver,
} from './index.js';

type SlotId = 'slot1' | 'slot2' | 'slot3';
const SLOT_IDS: SlotId[] = ['slot1', 'slot2', 'slot3'];

let nextDocUid = 1;
function newDocUid(): string {
  return `doc-${nextDocUid++}`;
}

/**
 * One loaded document inside a slot's stack. Owns a live EditorView
 * (so swapping back to this record in the stack restores selection /
 * scroll / history without a re-mount), the per-doc nav surface, and
 * the per-doc editor drag surface.
 */
interface DocRecord {
  uid: string;
  filename: string;
  view: EditorView;
  /** Root element holding `view.dom`. Mounted into / detached from
   *  the slot's body when this record becomes / stops being visible. */
  editorEl: HTMLElement;
  navPanel: NavigationPanel;
  /** Root element holding `navPanel`'s output. Mounted into / detached
   *  from the slot's nav section when visibility changes. */
  navEl: HTMLElement;
  dragSurface: EditorDragSurface;
  /** Debounce handle for per-pane "heavy" work (nav re-render +
   *  word-count walk). Both are O(doc-size) operations that PM
   *  fires transactions for several times per keystroke (composite
   *  edits, selection sync, etc.). Single-doc debounces the same
   *  work via `scheduleHeavyUpdate`; we match its 200ms cadence so
   *  per-keystroke editing of a large doc stays responsive.
   *
   *  Also matters for the nav specifically: rebuilding the heading
   *  list replaces every `<li>` element, which would invalidate a
   *  dblclick in progress unless the rebuild waits for a typing
   *  pause. */
  heavyUpdateTimer: IdleHandle | null;
  /** Per-doc read-mode state. Multi-doc treats read mode as a
   *  property of an individual open doc — the ribbon toggle flips
   *  this for the focused pane only, leaving other panes untouched. */
  readMode: boolean;
}

class Slot {
  readonly id: SlotId;
  /** Top-level pane element (chip + editor + footer). Hidden when
   *  the stack is empty. */
  readonly paneEl: HTMLElement;
  /** Title chip text container. */
  private chipNameEl: HTMLElement;
  /** Title chip stack dropdown trigger (shown when stack has 2+). */
  private chipStackBtn: HTMLButtonElement;
  /** Title chip × close button. */
  private chipCloseBtn: HTMLButtonElement;
  /** Editor body — DocRecord.editorEl mounts here. */
  private bodyEl: HTMLElement;
  /** Footer word count. */
  private wcEl: HTMLElement;
  /** Nav section (in the multi-nav rail). Hidden when stack is empty. */
  readonly navSectionEl: HTMLElement;
  /** Nav body — DocRecord.navEl mounts here. */
  private navBodyEl: HTMLElement;
  /** Last width we wrote into `--pmd-card-intrinsic-width`. Skips
   *  no-op writes on repeated sync calls (e.g. multiple events
   *  firing in one frame for the same final width). */
  private lastIntrinsicWidth = -1;

  /** Live stack. Index 0 = bottom (least recently active);
   *  `visibleIndex` is the doc currently shown. */
  stack: DocRecord[] = [];
  visibleIndex = -1;

  /** Owning shell for routing focus / re-render events. */
  shell: MultiPaneShell;

  constructor(id: SlotId, shell: MultiPaneShell) {
    this.id = id;
    this.shell = shell;
    this.paneEl = document.createElement('div');
    this.paneEl.className = 'pmd-pane';
    this.paneEl.dataset['slot'] = id;
    this.paneEl.hidden = true;
    // Click anywhere in the pane → focus it (route shared ribbon /
    // chrome through this slot's visible doc).
    this.paneEl.addEventListener('mousedown', () => this.shell.focusSlot(this));

    // Title chip.
    const chip = document.createElement('div');
    chip.className = 'pmd-pane-chip';
    this.chipStackBtn = document.createElement('button');
    this.chipStackBtn.type = 'button';
    this.chipStackBtn.className = 'pmd-pane-chip-stack';
    this.chipStackBtn.title = 'Switch document in this slot';
    this.chipStackBtn.textContent = '▾';
    this.chipStackBtn.hidden = true;
    this.chipStackBtn.addEventListener('mousedown', (e) => e.preventDefault());
    this.chipStackBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.openStackDropdown();
    });
    chip.appendChild(this.chipStackBtn);
    this.chipNameEl = document.createElement('span');
    this.chipNameEl.className = 'pmd-pane-chip-name';
    chip.appendChild(this.chipNameEl);
    this.chipCloseBtn = document.createElement('button');
    this.chipCloseBtn.type = 'button';
    this.chipCloseBtn.className = 'pmd-pane-chip-close';
    this.chipCloseBtn.title = 'Close this document';
    this.chipCloseBtn.textContent = '×';
    this.chipCloseBtn.addEventListener('mousedown', (e) => e.preventDefault());
    this.chipCloseBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.closeVisible();
    });
    chip.appendChild(this.chipCloseBtn);
    this.paneEl.appendChild(chip);

    // Editor body container.
    this.bodyEl = document.createElement('div');
    this.bodyEl.className = 'pmd-pane-body';
    this.paneEl.appendChild(this.bodyEl);

    // Footer (word count + open file button).
    const footer = document.createElement('div');
    footer.className = 'pmd-pane-footer';
    this.wcEl = document.createElement('span');
    this.wcEl.className = 'pmd-pane-wc';
    this.wcEl.textContent = '—';
    footer.appendChild(this.wcEl);
    const openBtn = document.createElement('button');
    openBtn.type = 'button';
    openBtn.className = 'pmd-pane-open';
    openBtn.title = 'Open a file into this slot';
    openBtn.textContent = '+ Open file';
    openBtn.addEventListener('mousedown', (e) => e.preventDefault());
    openBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.shell.openFileIntoSlot(this.id);
    });
    footer.appendChild(openBtn);
    this.paneEl.appendChild(footer);

    // Nav section (lives in the multi-nav rail at left of window).
    this.navSectionEl = document.createElement('section');
    this.navSectionEl.className = 'pmd-multi-nav-section';
    this.navSectionEl.dataset['slot'] = id;
    this.navSectionEl.hidden = true;
    // Clicking anywhere in the nav section focuses this slot —
    // same affordance as clicking the pane itself. Without this,
    // clicking a heading would scroll the doc into view but the
    // chrome (font-size chip, read-mode button, etc.) would
    // continue routing through whatever pane was previously
    // focused, which feels broken when the user is navigating
    // via the nav pane.
    this.navSectionEl.addEventListener('mousedown', () => this.shell.focusSlot(this));
    this.navBodyEl = document.createElement('div');
    this.navBodyEl.className = 'pmd-multi-nav-body';
    this.navSectionEl.appendChild(this.navBodyEl);
  }

  /** Read the visible ProseMirror element's content-area width and
   *  write it into `--pmd-card-intrinsic-width` on the pane root.
   *  Cards inside use this variable as the fallback for
   *  `contain-intrinsic-width` (paired with the `auto` keyword) so
   *  off-screen-never-rendered cards in a narrow multi-pane slot
   *  size close to the real card width rather than a fixed 600px.
   *
   *  Measuring the PM root (not `bodyEl`) is deliberate — bodyEl's
   *  `offsetWidth` includes scrollbar gutter AND doesn't subtract
   *  the editor's inner padding, so it overshoots a card's actual
   *  width by enough to be visible at the doc edge. PM root's
   *  `clientWidth` is scrollbar-independent and we subtract its
   *  computed padding to land exactly on the content box where
   *  cards lay out.
   *
   *  Called explicitly on (a) push, (b) shell window resize, (c)
   *  layout-mode change, (d) active-count change. Deliberately NOT
   *  driven by ResizeObserver — the variable write triggers a
   *  layout pass on every card, and ResizeObserver-driven updates
   *  produced a hard feedback loop where the pane body's measured
   *  width kept growing each iteration after the user clicked into
   *  the editor. Explicit triggers can't re-fire from our own
   *  mutations. */
  syncCardIntrinsicWidth(): void {
    if (this.paneEl.hidden) return;
    const rec = this.visible;
    if (!rec) return;
    const pmEl = rec.view.dom as HTMLElement;
    const cs = getComputedStyle(pmEl);
    const padL = parseFloat(cs.paddingLeft) || 0;
    const padR = parseFloat(cs.paddingRight) || 0;
    const width = Math.round(pmEl.clientWidth - padL - padR);
    if (width <= 0) return;
    if (width === this.lastIntrinsicWidth) return;
    this.lastIntrinsicWidth = width;
    this.paneEl.style.setProperty('--pmd-card-intrinsic-width', `${width}px`);
  }

  /** The currently-visible doc record (or null when stack is empty). */
  get visible(): DocRecord | null {
    if (this.visibleIndex < 0 || this.visibleIndex >= this.stack.length) return null;
    return this.stack[this.visibleIndex]!;
  }

  /** Adopt a freshly-built DocRecord into this slot's stack. New doc
   *  becomes the visible one; previously-visible (if any) drops into
   *  the stack but its EditorView stays live (memory-resident). */
  push(record: DocRecord): void {
    // Detach the OLD visible record first — `detachVisible` reads
    // `this.visible`, which derives from `visibleIndex`, so it has
    // to run before we push the new record and shift the index.
    // Without this the old record's `editorEl` stayed in `bodyEl`
    // and `mountVisible` below appended the new one alongside it,
    // so both docs rendered on top of each other until the stack
    // switcher forced a re-mount.
    this.detachVisible();
    this.stack.push(record);
    this.visibleIndex = this.stack.length - 1;
    this.mountVisible();
    this.paneEl.hidden = false;
    this.navSectionEl.hidden = false;
    this.shell.refreshLayout();
    this.shell.focusSlot(this);
  }

  /** Switch the visible doc to the given record. */
  showRecord(record: DocRecord): void {
    const idx = this.stack.indexOf(record);
    if (idx < 0) return;
    if (idx === this.visibleIndex) return;
    this.detachVisible();
    this.visibleIndex = idx;
    this.mountVisible();
    this.shell.focusSlot(this);
  }

  /** Close the currently-visible doc. Reveals the next stack member
   *  (or empties the slot). */
  closeVisible(): void {
    const idx = this.visibleIndex;
    if (idx < 0) return;
    const closing = this.stack[idx]!;
    this.detachVisible();
    if (closing.heavyUpdateTimer !== null) {
      cancelIdle(closing.heavyUpdateTimer);
      closing.heavyUpdateTimer = null;
    }
    // Clear speech-doc designation if the closing doc was it —
    // matches Verbatim's `AutoClose` which clears
    // `Globals.ActiveSpeechDoc` when the speech doc is closed.
    const speechResolver = getSpeechDocResolver();
    if (speechResolver.getSpeechView() === closing.view) {
      speechResolver.setSpeech(null);
    }
    closing.view.destroy();
    closing.dragSurface.detach();
    this.stack.splice(idx, 1);
    if (this.stack.length === 0) {
      this.visibleIndex = -1;
      this.paneEl.hidden = true;
      this.navSectionEl.hidden = true;
      this.shell.refreshLayout();
      // If this slot was focused, hand focus to the next active slot.
      this.shell.handleSlotEmptied(this);
      return;
    }
    // Show the next-newest doc (the one that was second-from-top).
    this.visibleIndex = Math.min(idx, this.stack.length - 1);
    this.mountVisible();
    this.shell.focusSlot(this);
  }

  /** Detach the currently-mounted record's DOM (without destroying
   *  its view — the view stays live for fast swap-back). */
  private detachVisible(): void {
    const rec = this.visible;
    if (!rec) return;
    if (rec.editorEl.parentElement === this.bodyEl) {
      this.bodyEl.removeChild(rec.editorEl);
    }
    if (rec.navEl.parentElement === this.navBodyEl) {
      this.navBodyEl.removeChild(rec.navEl);
    }
  }

  /** Mount the currently-visible record's editor + nav DOM into the
   *  slot's body / nav section. Updates the chip + word count. */
  private mountVisible(): void {
    const rec = this.visible;
    if (!rec) return;
    this.bodyEl.appendChild(rec.editorEl);
    this.navBodyEl.appendChild(rec.navEl);
    this.chipNameEl.textContent = rec.filename;
    this.refreshChip();
    this.refreshWordCount();
    // Speech-chip class lives on the pane element and reflects
    // the currently-visible record vs the speech-doc registry;
    // swapping records via the stack switcher needs to refresh.
    this.shell.refreshSpeechChips();
  }

  /** Update the chip's stack-dropdown trigger visibility based on
   *  current stack depth. */
  refreshChip(): void {
    const multi = this.stack.length > 1;
    this.chipStackBtn.hidden = !multi;
    this.chipStackBtn.textContent = multi ? `▾ ${this.stack.length}` : '▾';
  }

  /** Recompute and display the visible doc's word count + read times
   *  for the first two configured readers. */
  refreshWordCount(): void {
    const rec = this.visible;
    if (!rec) {
      this.wcEl.textContent = '—';
      return;
    }
    const sel = rec.view.state.selection;
    const hasSel = !sel.empty;
    const words = hasSel
      ? countReadAloudWords(rec.view.state.doc, sel.from, sel.to)
      : countReadAloudWords(rec.view.state.doc);
    const readers = settings.get('readers').slice(0, 2);
    const head = hasSel
      ? `Sel: ${formatNumber(words)}`
      : formatNumber(words);
    const parts = [head];
    for (const r of readers) {
      parts.push(`${r.name}: ${formatReadTime(words, r.wpm)}`);
    }
    this.wcEl.textContent = parts.join(' · ');
  }

  /** Open a small dropdown over the chip listing every doc in this
   *  slot's stack. Each entry switches the visible doc; each carries
   *  a × icon that closes that entry. */
  private openStackDropdown(): void {
    closeOpenStackDropdown();
    const dropdown = document.createElement('div');
    dropdown.className = 'pmd-pane-chip-dropdown';
    for (const rec of this.stack) {
      const row = document.createElement('div');
      row.className = 'pmd-pane-chip-dropdown-row';
      if (rec === this.visible) row.classList.add('pmd-active');
      const name = document.createElement('span');
      name.className = 'pmd-pane-chip-dropdown-name';
      name.textContent = rec.filename;
      name.addEventListener('click', () => {
        closeOpenStackDropdown();
        this.showRecord(rec);
      });
      row.appendChild(name);
      const close = document.createElement('button');
      close.type = 'button';
      close.className = 'pmd-pane-chip-dropdown-close';
      close.textContent = '×';
      close.title = 'Close this document';
      close.addEventListener('mousedown', (e) => e.preventDefault());
      close.addEventListener('click', (e) => {
        e.stopPropagation();
        closeOpenStackDropdown();
        this.closeRecord(rec);
      });
      row.appendChild(close);
      dropdown.appendChild(row);
    }
    document.body.appendChild(dropdown);
    const rect = this.chipStackBtn.getBoundingClientRect();
    dropdown.style.position = 'absolute';
    dropdown.style.top = `${rect.bottom + window.scrollY + 2}px`;
    dropdown.style.left = `${rect.left + window.scrollX}px`;
    openStackDropdownEl = dropdown;
    const onDoc = (e: PointerEvent) => {
      const t = e.target as Node | null;
      if (t && dropdown.contains(t)) return;
      closeOpenStackDropdown();
      document.removeEventListener('pointerdown', onDoc);
    };
    setTimeout(() => document.addEventListener('pointerdown', onDoc), 0);
  }

  /** Close a specific record (not necessarily the visible one). */
  closeRecord(rec: DocRecord): void {
    const idx = this.stack.indexOf(rec);
    if (idx < 0) return;
    if (idx === this.visibleIndex) {
      this.closeVisible();
      return;
    }
    if (rec.heavyUpdateTimer !== null) {
      cancelIdle(rec.heavyUpdateTimer);
      rec.heavyUpdateTimer = null;
    }
    // Clear speech-doc designation if the closing record was it.
    const speechResolver = getSpeechDocResolver();
    if (speechResolver.getSpeechView() === rec.view) {
      speechResolver.setSpeech(null);
    }
    rec.view.destroy();
    rec.dragSurface.detach();
    this.stack.splice(idx, 1);
    if (idx < this.visibleIndex) this.visibleIndex--;
    this.refreshChip();
  }
}

let openStackDropdownEl: HTMLElement | null = null;
function closeOpenStackDropdown(): void {
  if (!openStackDropdownEl) return;
  openStackDropdownEl.remove();
  openStackDropdownEl = null;
}

class MultiPaneShell {
  private slots: Record<SlotId, Slot>;
  private shellEl: HTMLElement;
  private navRailEl: HTMLElement;
  private rowEl: HTMLElement;
  private focusedSlot: Slot | null = null;
  private layoutMode: 'compact' | 'wide';
  private unsubscribeSettings: (() => void) | null = null;

  constructor() {
    this.layoutMode = settings.get('multiDocLayoutMode');
    // Build the shell DOM and mount it into #app, alongside the
    // (now-hidden) single-doc surfaces.
    const app = document.getElementById('app')!;
    this.shellEl = document.createElement('div');
    this.shellEl.id = 'multi-pane-shell';
    this.shellEl.className = 'pmd-multi-shell';
    this.shellEl.dataset['layout'] = this.layoutMode;
    app.appendChild(this.shellEl);

    // Nav rail sits at the window's left edge, OUTSIDE the existing
    // #nav-panel (which is hidden in multi-doc mode). Use absolute
    // positioning via CSS to align it with the window edge.
    this.navRailEl = document.createElement('aside');
    this.navRailEl.className = 'pmd-multi-nav';
    document.body.appendChild(this.navRailEl);

    // Pane row (the three editor panes).
    this.rowEl = document.createElement('div');
    this.rowEl.className = 'pmd-multi-row';
    this.rowEl.dataset['layout'] = this.layoutMode;
    this.shellEl.appendChild(this.rowEl);

    this.slots = {
      slot1: new Slot('slot1', this),
      slot2: new Slot('slot2', this),
      slot3: new Slot('slot3', this),
    };
    for (const id of SLOT_IDS) {
      this.rowEl.appendChild(this.slots[id].paneEl);
      this.navRailEl.appendChild(this.slots[id].navSectionEl);
    }

    this.unsubscribeSettings = settings.subscribe((s) => {
      if (s.multiDocLayoutMode !== this.layoutMode) {
        this.layoutMode = s.multiDocLayoutMode;
        this.shellEl.dataset['layout'] = this.layoutMode;
        this.rowEl.dataset['layout'] = this.layoutMode;
        // Layout mode swap → pane widths change → re-sync card
        // intrinsic widths so skipped cards aren't sized for the
        // OLD layout's pane width.
        this.scheduleSyncAllCardIntrinsicWidths();
      }
      // Pane word counts depend on reader settings.
      for (const id of SLOT_IDS) this.slots[id].refreshWordCount();
      // Editor spellcheck toggle — apply to every record's view in
      // every slot's stack, including hidden stack members (their
      // editorEl is detached but the attribute still sticks for
      // when they swap into view).
      const spellcheck = s.editorSpellcheck ? 'true' : 'false';
      for (const id of SLOT_IDS) {
        for (const rec of this.slots[id].stack) {
          rec.view.dom.setAttribute('spellcheck', spellcheck);
        }
      }
      // Read-mode is per-pane in multi-doc — flipped via the
      // ribbon command's `toggleReadMode` hook below — so we
      // deliberately ignore changes to the global
      // `settings.readMode` here. Otherwise toggling read mode in
      // one pane would force every other open doc into the same
      // state.
      // The `pmd-rm-no-emphasis-borders` flag IS settings-driven
      // (it's a display preference, not per-doc), so when it
      // changes we re-stamp the class on every currently-read-
      // mode'd pane to match.
      const hideEmphasisBorders = s.hideEmphasisBordersInReadMode;
      for (const id of SLOT_IDS) {
        for (const rec of this.slots[id].stack) {
          if (rec.readMode) {
            rec.editorEl.classList.toggle(
              'pmd-rm-no-emphasis-borders',
              hideEmphasisBorders,
            );
          }
        }
      }
      // Nav drag changes available pane width — re-sync.
      this.scheduleSyncAllCardIntrinsicWidths();
    });

    // Tell the single-doc index.ts how to query "what should the
    // read-mode button show?" — in multi-doc that's the focused
    // pane's per-doc state, not the global setting.
    setReadModeStateResolver(() => this.focusedSlot?.visible?.readMode ?? false);

    // Keep the speech chip / button state in sync with the
    // registry — the registry fires on every set/clear, including
    // ones the shell itself initiated.
    getSpeechDocResolver().subscribe(() => this.refreshSpeechChips());

    // Window resize is the other event that legitimately changes
    // pane widths. Deliberately NOT a ResizeObserver — see the doc
    // comment on Slot.syncCardIntrinsicWidth for why.
    window.addEventListener('resize', this.onWindowResize);

    // Mod-1 / Mod-2 / Mod-3 focus the corresponding slot's pane.
    // Listener is on `window` (not the editor's PM keymap) so the
    // shortcut works even when no pane currently has keyboard
    // focus. We `preventDefault` to suppress the browser's
    // "switch tab" default — these are inside our app shell so
    // tab-switching wouldn't make sense.
    window.addEventListener('keydown', this.onSlotShortcutKey);

    // Drag-hover focus + post-drop collapse:
    //
    //   - On 'move': the controller's hoverTarget tells us which
    //     view the drop will land in. When the user hovers over
    //     a pane (even before releasing), focus that pane so the
    //     ribbon / chrome retarget. Stash the source/target views
    //     too so we can detect cross-view drops on 'end'.
    //   - On 'end': if this was a cross-view drop, apply the
    //     destination pane's outline-level filter to the freshly-
    //     dropped headings (which got fresh IDs via
    //     rewriteHeadingIds). Existing user expansions stay.
    let lastSourceView: EditorView | null = null;
    let lastTargetView: EditorView | null = null;
    dragController.subscribe((event) => {
      if (event === 'begin') {
        const session = dragController.getSession();
        lastSourceView = session?.view ?? null;
        lastTargetView = null;
      } else if (event === 'move') {
        const target = dragController.getHoverTarget();
        if (target) {
          lastTargetView = target.view;
          const slot = this.findSlotByView(target.view);
          if (slot && this.focusedSlot !== slot) this.focusSlot(slot);
        }
      } else if (event === 'end') {
        if (
          lastSourceView &&
          lastTargetView &&
          lastSourceView !== lastTargetView
        ) {
          const targetSlot = this.findSlotByView(lastTargetView);
          if (targetSlot?.visible) {
            // Flush the pane's debounced nav update so this runs
            // against the post-drop doc and the new IDs are visible.
            const rec = targetSlot.visible;
            if (rec.heavyUpdateTimer !== null) {
              cancelIdle(rec.heavyUpdateTimer);
              rec.heavyUpdateTimer = null;
            }
            rec.navPanel.applyMaxLevelToNewHeadings();
          }
        }
        lastSourceView = null;
        lastTargetView = null;
      }
    });

    // First active slot gets focus by default once a doc lands.
  }

  private findSlotByView(view: EditorView): Slot | null {
    for (const id of SLOT_IDS) {
      if (this.slots[id].visible?.view === view) return this.slots[id];
    }
    return null;
  }

  /** Refresh the data-attribute count on the row, used by CSS to
   *  size each pane based on how many slots are active. */
  refreshLayout(): void {
    const active = SLOT_IDS.filter((id) => this.slots[id].stack.length > 0).length;
    this.rowEl.dataset['active'] = String(active);
    this.navRailEl.dataset['active'] = String(active);
    // Active-count change → pane widths change → re-sync.
    this.scheduleSyncAllCardIntrinsicWidths();
  }

  /** Pending rAF id for the next card-intrinsic-width batch. */
  private syncIntrinsicRaf: number | null = null;

  /** Coalesce multiple sync triggers landing in the same tick into a
   *  single rAF read, so we measure once after layout settles rather
   *  than mid-flight. The cache check inside `syncCardIntrinsicWidth`
   *  is doing the no-op short-circuit; this just avoids stacking
   *  redundant rAFs. */
  scheduleSyncAllCardIntrinsicWidths(): void {
    if (this.syncIntrinsicRaf !== null) return;
    this.syncIntrinsicRaf = requestAnimationFrame(() => {
      this.syncIntrinsicRaf = null;
      for (const id of SLOT_IDS) this.slots[id].syncCardIntrinsicWidth();
    });
  }

  private onWindowResize = (): void => {
    this.scheduleSyncAllCardIntrinsicWidths();
  };

  /** Mod-1 / Mod-2 / Mod-3 → focus slot 1 / 2 / 3. Skips when
   *  the keystroke also carries Shift / Alt (so chords like
   *  `Mod-Shift-1` stay available for other purposes) and when
   *  the target slot has no doc loaded. Calling `focusSlot` does
   *  the focus dance and routes the shared chrome through the
   *  slot's visible view; we also call `view.focus()` so the
   *  keystroke transfers actual keyboard focus into the doc. */
  private onSlotShortcutKey = (e: KeyboardEvent): void => {
    if (e.defaultPrevented) return;
    const modOnly = (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey;
    if (!modOnly) return;
    let idx = -1;
    if (e.key === '1') idx = 0;
    else if (e.key === '2') idx = 1;
    else if (e.key === '3') idx = 2;
    if (idx < 0) return;
    const slot = this.slots[SLOT_IDS[idx]!];
    if (slot.stack.length === 0) return;
    e.preventDefault();
    this.focusSlot(slot);
    slot.visible?.view.focus();
  };

  /** Mark `slot` as focused. The shared ribbon / chrome will route
   *  through its visible doc's EditorView. In wide-scroll layout
   *  with three active panes, also scroll the focused pane into
   *  view IF it's not already fully visible — clicking the peeking
   *  third doc brings it into view, but clicking the middle (fully
   *  visible) doc leaves the scroll position alone. */
  focusSlot(slot: Slot): void {
    const wasSame = this.focusedSlot === slot && getActiveView() === slot.visible?.view;
    if (this.focusedSlot && this.focusedSlot !== slot) {
      this.focusedSlot.paneEl.classList.remove('pmd-pane-focused');
    }
    this.focusedSlot = slot;
    slot.paneEl.classList.add('pmd-pane-focused');
    if (!wasSame) {
      setActiveView(slot.visible?.view ?? null);
    }
    const activeCount = SLOT_IDS.filter((id) => this.slots[id].stack.length > 0).length;
    if (this.layoutMode === 'wide' && activeCount === 3) {
      // Compare the pane's box against the row's viewport. If any
      // part of the pane is clipped (off-screen), scroll it into
      // view. The `scroll-snap-type` on the row aligns the landing
      // position to a snap point; if the pane is already fully
      // inside the viewport (e.g., the middle pane), skip the
      // scroll so the user doesn't see an unwanted snap.
      const rowRect = this.rowEl.getBoundingClientRect();
      const paneRect = slot.paneEl.getBoundingClientRect();
      const fullyVisible =
        paneRect.left >= rowRect.left - 0.5 &&
        paneRect.right <= rowRect.right + 0.5;
      if (!fullyVisible) {
        // `behavior: 'auto'` overrides the row's
        // `scroll-behavior: smooth`. Smooth scroll would otherwise
        // get paused mid-animation by ProseMirror's own pointerdown
        // handling on the same tick (focus + cursor placement +
        // implicit focused-element scroll-into-view), which made
        // the user have to hold the mouse button down to see the
        // transition finish. Instant snap with `scroll-snap-type`
        // still keeps the landing position aligned.
        //
        // The rAF defer also helps — PM's handlers run on the
        // current tick; we run on the next so the scroll target
        // doesn't get clobbered before it takes effect.
        const target = slot.paneEl;
        requestAnimationFrame(() => {
          target.scrollIntoView({ inline: 'start', block: 'nearest', behavior: 'auto' });
        });
      }
    }
  }

  /** Flip the read-mode state of the focused pane's visible doc.
   *  Called by the ribbon's `toggleReadMode` command (the global
   *  command dispatches into the shell via `enableMultiDocMode`'s
   *  `toggleReadMode` hook). No-op if no pane is focused. */
  toggleFocusedReadMode(): void {
    const rec = this.focusedSlot?.visible;
    if (!rec) return;
    rec.readMode = !rec.readMode;
    applyReadModeToTarget(
      rec.editorEl,
      rec.view,
      rec.readMode,
      settings.get('hideEmphasisBordersInReadMode'),
    );
    // setActiveView is the path that drives `refreshReadModeBtn`,
    // so we route through it to keep the ribbon button in sync.
    setActiveView(rec.view);
  }

  /** Handle a slot becoming empty — if it had focus, transfer to
   *  the next active slot (or clear focus). */
  handleSlotEmptied(slot: Slot): void {
    if (this.focusedSlot !== slot) return;
    this.focusedSlot = null;
    for (const id of SLOT_IDS) {
      if (this.slots[id].stack.length > 0) {
        this.focusSlot(this.slots[id]);
        return;
      }
    }
    setActiveView(null);
  }

  /** Trigger the OS file picker, routed to a known slot (no prompt
   *  since the user clicked that slot's Open button). */
  openFileIntoSlot(target: SlotId): void {
    pendingRoute = target;
    triggerFilePicker();
  }

  /** Called by the global dropzone change handler (delegated through
   *  `enableMultiDocMode`) when a file is picked. */
  async onFileOpen(file: File): Promise<void> {
    // If the user reached here via an Open-into-this-slot button,
    // skip the inline picker and route to the chosen slot.
    if (pendingRoute) {
      const target = pendingRoute;
      pendingRoute = null;
      await this.loadFileIntoSlot(file, target);
      return;
    }
    // Otherwise show the inline routing picker first.
    const choice = await this.promptForSlot(file.name);
    if (!choice) return;
    await this.loadFileIntoSlot(file, choice);
  }

  /** Show the inline "Send to slot…" picker; resolves with the
   *  chosen slot, or null if the user cancels. */
  private promptForSlot(filename: string): Promise<SlotId | null> {
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.className = 'pmd-route-overlay';
      const dialog = document.createElement('div');
      dialog.className = 'pmd-route-dialog';
      const header = document.createElement('div');
      header.className = 'pmd-route-header';
      header.textContent = `Open ${filename} into…`;
      dialog.appendChild(header);
      const row = document.createElement('div');
      row.className = 'pmd-route-buttons';
      for (const id of SLOT_IDS) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'pmd-route-btn';
        const slot = this.slots[id];
        const stackLabel =
          slot.stack.length === 0
            ? '(empty)'
            : `${slot.visible?.filename ?? ''}${slot.stack.length > 1 ? ` (+${slot.stack.length - 1})` : ''}`;
        btn.innerHTML = `<strong>${id.replace('slot', 'Slot ')}</strong><br><span>${stackLabel}</span>`;
        btn.addEventListener('click', () => {
          overlay.remove();
          resolve(id);
        });
        row.appendChild(btn);
      }
      dialog.appendChild(row);
      const cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.className = 'pmd-route-cancel';
      cancel.textContent = 'Cancel';
      cancel.addEventListener('click', () => {
        overlay.remove();
        resolve(null);
      });
      dialog.appendChild(cancel);
      overlay.appendChild(dialog);
      document.body.appendChild(overlay);
      // Esc cancels.
      const onKey = (e: KeyboardEvent) => {
        if (e.key === 'Escape') {
          document.removeEventListener('keydown', onKey);
          overlay.remove();
          resolve(null);
        }
      };
      document.addEventListener('keydown', onKey);
    });
  }

  /** Parse + import + mount a file into the given slot. */
  private async loadFileIntoSlot(file: File, target: SlotId): Promise<void> {
    const buf = await file.arrayBuffer();
    const { doc } = await fromDocxFull(new Uint8Array(buf));
    const slot = this.slots[target];
    const record = buildDocRecord(file.name, doc, slot);
    slot.push(record);
  }

  /** Create an empty doc; prompt for slot. Used by the ribbon's
   *  "New doc" button. */
  async createNewDoc(): Promise<void> {
    const target = await this.promptForSlot('Untitled');
    if (!target) return;
    const doc = makeBlankDoc();
    const slot = this.slots[target];
    const record = buildDocRecord('Untitled.docx', doc, slot);
    slot.push(record);
  }

  /** Create a new speech document and mark it as the active speech
   *  doc. Verbatim parallels: `Paperless.NewSpeech` prompts for a
   *  round name ("1NC", "2AC vs Hogwarts", etc.); we do the same
   *  via a simple `prompt()` plus the standard slot picker. The
   *  fresh doc auto-registers as the speech doc — that's the
   *  whole point of `NewSpeech` (vs the generic `New doc`). */
  async createNewSpeechDocument(): Promise<void> {
    const roundName = window.prompt(
      'Which speech? (e.g. 1NC, 2AC Round 3 vs Hogwarts)',
      '',
    );
    if (roundName == null) return;
    const trimmed = roundName.trim();
    if (!trimmed) return;
    const target = await this.promptForSlot(`Speech ${trimmed}`);
    if (!target) return;
    const filename = formatSpeechFilename(trimmed);
    const doc = makeBlankDoc();
    const slot = this.slots[target];
    const record = buildDocRecord(filename, doc, slot);
    slot.push(record);
    // Mark immediately. `slot.push` already routed focus through
    // `setActiveView` (which fires the registry resolver hook).
    getSpeechDocResolver().setSpeech(record.view);
    this.refreshSpeechChips();
  }

  /** Toggle the focused pane's speech-doc designation. If the
   *  focused doc IS already the speech doc, clear the designation.
   *  Otherwise mark it (replacing any previous). No-op if no pane
   *  is focused. */
  markFocusedAsSpeech(): void {
    const rec = this.focusedSlot?.visible;
    if (!rec) return;
    const resolver = getSpeechDocResolver();
    const next = resolver.getSpeechView() === rec.view ? null : rec.view;
    resolver.setSpeech(next);
    this.refreshSpeechChips();
  }

  /** Send the focused pane's selection (or its enclosing heading-
   *  and-content range if the selection is empty) into the speech
   *  doc. `atEnd` controls the insertion point — true → after the
   *  doc-end, false → at the speech doc's current cursor. Verbatim:
   *  `Paperless.SendToSpeech PasteAtEnd:=true|false`. */
  sendToSpeech(atEnd: boolean): void {
    const sourceRec = this.focusedSlot?.visible;
    if (!sourceRec) return;
    const speechView = getSpeechDocResolver().getSpeechView();
    if (!speechView) {
      window.alert(
        'No speech document yet. Use "New speech document" to create one or "Mark active doc as speech" to designate an existing pane.',
      );
      return;
    }
    // If the user is sending FROM the speech doc itself, no-op for
    // now — Verbatim inserts a `~ Marked HH:MM ~` card-marker here,
    // which we agreed to skip until the schema gains a font_color
    // mark to render the red marker text.
    if (sourceRec.view === speechView) return;

    const sliceFromSource = resolveSendSlice(sourceRec.view);
    if (!sliceFromSource) return;

    // Cross-view insertion: rewrite heading ids so the destination
    // doesn't collide with the source's, then drop the slice in.
    // Same path the drag controller uses for cross-view drops.
    const rewritten = rewriteHeadingIds(sliceFromSource);
    const state = speechView.state;

    // Resolve the destination range. Two refinements over a naive
    // `tr.insert(pos, content)`:
    //   1. At-end picks the literal end-of-doc.
    //   2. If the cursor (or doc tail in at-end mode) sits in an
    //      empty top-level textblock, we REPLACE that block with
    //      the slice rather than splitting it — otherwise the
    //      placeholder paragraph that `makeBlankDoc` seeds the
    //      speech doc with would leave a stray empty line above
    //      every sent card. Verbatim's flow has Word's paste fill
    //      the empty paragraph naturally; we get the same UX by
    //      collapsing the empty block into the insertion range.
    let from: number;
    let to: number;
    if (atEnd) {
      const lastChild = state.doc.lastChild;
      if (lastChild && lastChild.isTextblock && lastChild.content.size === 0) {
        to = state.doc.content.size;
        from = to - lastChild.nodeSize;
      } else {
        from = state.doc.content.size;
        to = from;
      }
    } else {
      const $from = state.selection.$from;
      const isEmpty = state.selection.empty;
      const inBlankLine =
        isEmpty &&
        $from.depth >= 1 &&
        $from.parent.isTextblock &&
        $from.parent.content.size === 0;
      if (inBlankLine) {
        from = $from.before($from.depth);
        to = $from.after($from.depth);
      } else {
        from = state.selection.from;
        to = state.selection.from;
      }
    }

    const tr = state.tr;
    // `replaceRange` (vs `replaceWith`) handles slices with open
    // boundaries — non-empty text selections inside a card body
    // produce slices with `openStart`/`openEnd` > 0, and
    // replaceRange wraps / fits them into the destination schema.
    tr.replaceRange(from, to, rewritten);

    // Append a trailing empty paragraph after the inserted content
    // so the next send has a fresh blank line to land into — and
    // so this send's cursor can land THERE, satisfying the
    // "consecutive sends accumulate in order" invariant. Without
    // the trailer, the cursor would have to land inside the last
    // text node of the inserted slice (the only valid text
    // position after the insert), which would cause the next
    // send to interleave INSIDE that node instead of after it.
    const sliceEndPos = tr.mapping.map(to);
    const trailer = schema.nodes['paragraph']!.create();
    tr.insert(sliceEndPos, trailer);
    // Cursor inside the trailer (position is just past the
    // trailer's opening boundary token).
    tr.setSelection(TextSelection.create(tr.doc, sliceEndPos + 1));

    speechView.dispatch(tr.scrollIntoView());
    // Route focus to the speech doc so subsequent ` keystrokes
    // either insert markers (when we add them) or send the next
    // slice — same flow Verbatim users expect.
    speechView.focus();
    const speechSlot = this.findSlotByView(speechView);
    if (speechSlot) this.focusSlot(speechSlot);
  }

  /** Sync the visual speech indicator on every slot's chip with
   *  the registry's current state. Called whenever the speech
   *  designation changes or a slot's visible doc changes. */
  refreshSpeechChips(): void {
    const speechView = getSpeechDocResolver().getSpeechView();
    for (const id of SLOT_IDS) {
      const slot = this.slots[id];
      const isSpeech = !!speechView && slot.visible?.view === speechView;
      slot.paneEl.classList.toggle('pmd-pane-speech', isSpeech);
    }
  }
}

/** Format a Verbatim-style speech filename: "Speech <round> M-D
 *  H:MMam/pm.docx". Mirrors `Paperless.NewSpeech`'s filename
 *  construction so users who lean on filename-based workflows
 *  (USB save, recent-files menu) see a consistent shape. */
function formatSpeechFilename(round: string): string {
  const now = new Date();
  const month = now.getMonth() + 1;
  const day = now.getDate();
  let hour = now.getHours();
  const minute = now.getMinutes();
  const ampm = hour < 12 ? 'AM' : 'PM';
  if (hour === 0) hour = 12;
  else if (hour > 12) hour -= 12;
  const m = String(minute).padStart(2, '0');
  return `Speech ${round} ${month}-${day} ${hour}-${m}${ampm}.docx`;
}

/** Decide what slice to send from the source view:
 *    - Non-empty selection → exactly that range.
 *    - Empty selection → the smallest enclosing heading-and-content
 *      range (card / analytic_unit / pocket / hat / block), found
 *      by walking up `$pos.depth` and applying the same
 *      heading-range semantics `headings.computeHeadingRange`
 *      uses for nav-pane drops.
 *  Returns null when no slice could be resolved (e.g., cursor in
 *  a position with no enclosing heading container). */
function resolveSendSlice(view: EditorView): import('prosemirror-model').Slice | null {
  const state = view.state;
  const sel = state.selection;
  if (!sel.empty) {
    return state.doc.slice(sel.from, sel.to);
  }
  const $pos = sel.$from;
  const doc = state.doc;
  for (let depth = $pos.depth; depth >= 0; depth--) {
    const node = $pos.node(depth);
    const t = node.type.name;
    if (t === 'card' || t === 'analytic_unit') {
      const from = $pos.before(depth);
      return doc.slice(from, from + node.nodeSize);
    }
    if (t === 'pocket' || t === 'hat' || t === 'block') {
      // Heading + everything until the next equal-or-shallower
      // heading. Same semantics computeHeadingRange uses.
      const from = $pos.before(depth);
      const headingLevel = t === 'pocket' ? 1 : t === 'hat' ? 2 : 3;
      let to = doc.content.size;
      doc.nodesBetween(from + node.nodeSize, doc.content.size, (n, p) => {
        if (to !== doc.content.size) return false;
        const nt = n.type.name;
        const nLevel =
          nt === 'pocket' ? 1
          : nt === 'hat' ? 2
          : nt === 'block' ? 3
          : null;
        if (nLevel !== null && nLevel <= headingLevel) {
          to = p;
          return false;
        }
        return true;
      });
      return doc.slice(from, to);
    }
  }
  return null;
}

/** Minimal valid doc — one empty paragraph. Used by `createNewDoc`
 *  so the freshly-routed slot has something to put a cursor into. */
function makeBlankDoc(): PMNode {
  return schema.nodes['doc']!.createChecked(null, [
    schema.nodes['pocket']!.create({ id: newHeadingId() }, schema.text('Untitled')),
    schema.nodes['paragraph']!.create(null),
  ]);
}

/** Single shell instance — multi-pane is a binary mode, so one is
 *  enough. */
let shell: MultiPaneShell | null = null;

/** Track which slot to open into when the next file-pick fires.
 *  Set by the per-pane Open button so it can skip the inline picker. */
let pendingRoute: SlotId | null = null;

/** Trigger the global dropzone's file picker. */
function triggerFilePicker(): void {
  const dropzone = document.getElementById('dropzone') as HTMLInputElement | null;
  if (dropzone) dropzone.click();
}

/** Build a fresh DocRecord — wraps the per-doc PM state, nav panel,
 *  editor drag surface, and DOM containers needed for slot mounting. */
function buildDocRecord(filename: string, doc: PMNode, slot: Slot): DocRecord {
  const editorEl = document.createElement('div');
  editorEl.className = 'pmd-pane-editor';
  const navEl = document.createElement('div');
  navEl.className = 'pmd-pane-nav-host';

  const state = EditorState.create({
    doc,
    schema,
    plugins: buildEditorPlugins(),
  });

  // Per-pane EditorView. dispatchTransaction keeps the slot's word
  // count / chip / chrome in sync; if this pane is currently focused,
  // we also nudge the shared chrome (font-size chip etc.) via
  // `setActiveView` so the ribbon stays in sync as the cursor / doc
  // changes.
  const view: EditorView = new EditorView(editorEl, {
    state,
    // Browser spellcheck — driven by the `editorSpellcheck` setting,
    // off by default. The MultiPaneShell's settings subscriber pushes
    // runtime toggles onto every record's `view.dom` so the user
    // can flip it across all open panes without a reload.
    attributes: { spellcheck: settings.get('editorSpellcheck') ? 'true' : 'false' },
    dispatchTransaction(tx) {
      const next = view.state.apply(tx);
      view.updateState(next);
      // Debounce both O(doc-size) updates into a single timer:
      //   - navPanel.update walks the doc for headings (and
      //     rebuilds every `<li>`, which would invalidate any
      //     dblclick in progress if it ran per keystroke)
      //   - slot.refreshWordCount walks every text node for the
      //     read-aloud count
      // Running these on every transaction makes typing in large
      // docs O(N) per keystroke. The 200ms timer matches the
      // single-doc `scheduleHeavyUpdate` cadence.
      if (record.heavyUpdateTimer !== null) {
        cancelIdle(record.heavyUpdateTimer);
      }
      record.heavyUpdateTimer = scheduleIdle(() => {
        record.heavyUpdateTimer = null;
        record.navPanel.update(view.state.doc);
        slot.refreshWordCount();
      }, 200);
      // Cheap O(1) chrome refresh — keeps the font-size chip in
      // sync as the cursor moves. `setActiveView`'s call to
      // `refreshWordCount` short-circuits in multi-doc mode
      // because the shared status-bar counter is hidden anyway.
      if (getActiveView() === view) {
        setActiveView(view);
      }
    },
  });

  // Per-pane nav panel with an INDEPENDENT outline-level filter
  // (`localMaxLevel`). Each section's 1/2/3/4 buttons act locally.
  const navPanel = new NavigationPanel(navEl, { localMaxLevel: true });
  navPanel.attach(view);

  const dragSurface = new EditorDragSurface();
  dragSurface.attach(view, editorEl);

  const record: DocRecord = {
    uid: newDocUid(),
    filename,
    view,
    editorEl,
    navPanel,
    navEl,
    dragSurface,
    heavyUpdateTimer: null,
    // New docs always start with read mode OFF. The user toggles
    // it per-pane via the ribbon command after opening.
    readMode: false,
  };
  return record;
}

/** Boot-time entry point — called from editor/index.ts when the
 *  multi-doc setting is on. Installs the multi-pane shell and the
 *  file-routing hook into the shared ribbon. */
export function mountMultiPaneShell(): void {
  if (shell) return;
  shell = new MultiPaneShell();
  enableMultiDocMode({
    onFileOpen: (file) => shell!.onFileOpen(file),
    onNewDoc: () => shell!.createNewDoc(),
    toggleReadMode: () => shell!.toggleFocusedReadMode(),
    newSpeechDocument: () => { void shell!.createNewSpeechDocument(); },
    markActiveAsSpeech: () => shell!.markFocusedAsSpeech(),
    sendToSpeechAtCursor: () => shell!.sendToSpeech(false),
    sendToSpeechAtEnd: () => shell!.sendToSpeech(true),
  });
}
