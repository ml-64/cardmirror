/**
 * Editor surface for cross-surface drag-and-drop.
 *
 * Phase 3a (nav→text): when ANY drag is active, this surface renders
 * drop indicators in the editor (horizontal lines spanning the
 * editor's width at top-of-each-heading positions, plus an end-of-doc
 * slot) and hits-tests them so the controller can land a drop here.
 * Indicator rendering is driven by subscription to the drag controller
 * — no need for the source surface to call us directly.
 *
 * Phase 3b (text→nav): when the user holds the pickup modifier
 * (Ctrl+Alt+Shift on Linux/Win, Cmd+Option+Shift on Mac), the editor
 * enters "pickup mode": the cursor changes to grab; hovering shows a
 * dashed-outline overlay around the smallest enclosing recognized
 * container under the pointer (Card / Block / Hat / Pocket / Analytic-
 * unit, smallest wins). A pointerdown in pickup mode begins a drag
 * with that container as the source. Releasing the modifier mid-drag
 * cancels.
 */

import type { EditorView } from 'prosemirror-view';
import { collectHeadings, computeHeadingRange, TYPE_TO_LEVEL } from './headings.js';
import { dragController, type DragItem, type DragSurface } from './drag-controller.js';
import { settings } from './settings.js';

interface IndicatorRecord {
  el: HTMLElement;
  insertPos: number;
}

interface HoveredContainer {
  from: number;
  to: number;
  type: string;
  level: number;
  label: string;
}

export class EditorDragSurface implements DragSurface {
  private view: EditorView | null = null;
  private host: HTMLElement | null = null;
  private indicators: IndicatorRecord[] = [];

  // Phase 3b state.
  private pickupModifierHeld = false;
  private hovered: HoveredContainer | null = null;
  private highlightBox: HTMLElement | null = null;
  private dragOriginatedHere = false;
  private editorPointerMoveAttached = false;
  /** Last known pointer position (cached from a global mousemove
   *  listener). Used to do an immediate hit-test when the pickup
   *  modifier activates — without this, the user would have to move
   *  the mouse before seeing the highlight. */
  private lastClientX = -1;
  private lastClientY = -1;

  // Subscriptions / cleanups.
  private unsubscribeDrag: (() => void) | null = null;
  private unregisterSurface: (() => void) | null = null;

  // Bound handlers.
  private boundOnKey = (e: KeyboardEvent) => this.onKey(e);
  private boundOnBlur = () => this.onBlur();
  private boundOnGlobalMove = (e: MouseEvent) => this.onGlobalMove(e);
  private boundOnHostMove = (e: PointerEvent) => this.onHostPointerMove(e);
  private boundOnHostDown = (e: PointerEvent) => this.onHostPointerDown(e);
  private boundOnDocMove = (e: PointerEvent) => this.onDocPointerMoveDuringDrag(e);
  private boundOnDocUp = (e: PointerEvent) => this.onDocPointerUpDuringDrag(e);

  /** Cached scroll-gate element (the nearest scrolling ancestor of
   *  host, or host itself). Reused by every hit-test so we don't
   *  walk the DOM on every pointermove. */
  private scrollGateEl: HTMLElement | null = null;

  /** Return the host's own scroller if it has one, otherwise the
   *  nearest ancestor whose `overflow-y` allows scrolling. Used by
   *  `hitTest` to decide whether the cursor is "inside the editor's
   *  visible drop region" — see the comment in `hitTest`. */
  private findScrollGate(): HTMLElement {
    if (this.scrollGateEl && this.scrollGateEl.isConnected) return this.scrollGateEl;
    let cur: HTMLElement | null = this.host;
    while (cur && cur !== document.body) {
      const overflow = getComputedStyle(cur).overflowY;
      if (overflow === 'auto' || overflow === 'scroll') {
        this.scrollGateEl = cur;
        return cur;
      }
      cur = cur.parentElement;
    }
    // Fall back to host (e.g., single-doc host that doesn't scroll
    // either, or a detached host during teardown).
    this.scrollGateEl = this.host;
    return this.host!;
  }

  attach(view: EditorView, hostEl: HTMLElement): void {
    this.view = view;
    this.host = hostEl;
    this.scrollGateEl = null;
    if (!hostEl.style.position) hostEl.style.position = 'relative';

    this.unregisterSurface = dragController.registerSurface(this);
    this.unsubscribeDrag = dragController.subscribe((event) => {
      if (event === 'begin') {
        // Eager render at drag start ensures cross-pane drop
        // targets (in multi-doc mode) have indicators ready the
        // moment the pointer enters them. Earlier attempt at
        // lazy-render-on-first-hitTest left target panes empty in
        // some cross-pane scenarios. With the two-pass layout-
        // batched renderIndicators below the cost is moderate.
        const session = dragController.getSession();
        if (session) this.renderIndicators(session.items[0]!.level);
      } else if (event === 'end') {
        this.removeIndicators();
        this.dragOriginatedHere = false;
        this.detachDragListeners();
        // Re-evaluate cursor based on current modifier state.
        this.applyPickupClass();
      }
    });

    document.addEventListener('keydown', this.boundOnKey);
    document.addEventListener('keyup', this.boundOnKey);
    document.addEventListener('mousemove', this.boundOnGlobalMove);
    window.addEventListener('blur', this.boundOnBlur);
    hostEl.addEventListener('pointermove', this.boundOnHostMove);
    hostEl.addEventListener('pointerdown', this.boundOnHostDown);
  }

  private onGlobalMove(e: MouseEvent): void {
    this.lastClientX = e.clientX;
    this.lastClientY = e.clientY;
  }

  detach(): void {
    if (this.unregisterSurface) {
      this.unregisterSurface();
      this.unregisterSurface = null;
    }
    if (this.unsubscribeDrag) {
      this.unsubscribeDrag();
      this.unsubscribeDrag = null;
    }
    document.removeEventListener('keydown', this.boundOnKey);
    document.removeEventListener('keyup', this.boundOnKey);
    document.removeEventListener('mousemove', this.boundOnGlobalMove);
    window.removeEventListener('blur', this.boundOnBlur);
    if (this.host) {
      this.host.removeEventListener('pointermove', this.boundOnHostMove);
      this.host.removeEventListener('pointerdown', this.boundOnHostDown);
      this.host.classList.remove('pmd-editor-pickup-mode');
      this.host.classList.remove('pmd-editor-dragging-mode');
    }
    this.detachDragListeners();
    this.removeIndicators();
    this.removeHighlight();
    this.hovered = null;
    this.pickupModifierHeld = false;
    this.dragOriginatedHere = false;
    this.view = null;
    this.host = null;
  }

  // ---- DragSurface implementation ----

  hitTest(clientX: number, clientY: number): { el: HTMLElement; insertPos: number; dy: number; view?: EditorView } | null {
    if (!this.host) return null;
    // For the hit-test gate, use the nearest SCROLLING ancestor — in
    // single-doc that's the host itself (`#editor` has overflow:auto),
    // in multi-doc that's the pane body (the host `.pmd-pane-editor`
    // has overflow:visible and its element box is locked to the
    // body's visible height while PM's content overflows further
    // down). Using the host's own rect rejects every cursor below
    // its box even though the editor content extends past it.
    const gateRect = this.findScrollGate().getBoundingClientRect();
    if (clientX < gateRect.left || clientX > gateRect.right) {
      return null;
    }
    // Generous vertical clamp so we don't claim drops far outside the
    // editor's visible area (e.g., user dragging over a totally
    // unrelated page region above or below).
    if (clientY < gateRect.top - 64 || clientY > gateRect.bottom + 64) {
      return null;
    }

    const session = dragController.getSession();
    type Cand = { el: HTMLElement; insertPos: number; centerY: number; dy: number };
    const valid: Cand[] = [];
    for (const r of this.indicators) {
      if (session) {
        const onSelf = session.items.some(
          (it) => r.insertPos > it.from && r.insertPos < it.to,
        );
        if (onSelf) continue;
      }
      const rect = r.el.getBoundingClientRect();
      const centerY = rect.top + rect.height / 2;
      valid.push({ el: r.el, insertPos: r.insertPos, centerY, dy: Math.abs(clientY - centerY) });
    }
    if (valid.length === 0) return null;

    const view = this.view ?? undefined;
    // Preferred: closest indicator within 32px band.
    let best: Cand | null = null;
    for (const v of valid) {
      if (v.dy > 32) continue;
      if (!best || v.dy < best.dy) best = v;
    }
    if (best) return { el: best.el, insertPos: best.insertPos, dy: best.dy, view };

    // Fall-through: pointer is above the topmost or below the
    // bottommost indicator (e.g., empty page space at the bottom).
    // Snap to the closest extreme.
    let topMost = valid[0]!;
    let bottomMost = valid[0]!;
    for (const v of valid) {
      if (v.centerY < topMost.centerY) topMost = v;
      if (v.centerY > bottomMost.centerY) bottomMost = v;
    }
    if (clientY > bottomMost.centerY) {
      return { el: bottomMost.el, insertPos: bottomMost.insertPos, dy: bottomMost.dy, view };
    }
    if (clientY < topMost.centerY) {
      return { el: topMost.el, insertPos: topMost.insertPos, dy: topMost.dy, view };
    }
    return null;
  }

  highlight(el: HTMLElement | null): void {
    for (const r of this.indicators) {
      r.el.classList.toggle('pmd-editor-drop-indicator-active', r.el === el);
    }
  }

  // ---- Indicator rendering (drop targets) ----

  private renderIndicators(draggedLevel: number): void {
    this.removeIndicators();
    if (!this.view || !this.host) return;
    const view = this.view;
    const host = this.host;

    // Use each heading's rendered DOM element to derive its CSS top
    // INSIDE the host (`offsetTop` walks the offsetParent chain).
    // Previously we used `view.coordsAtPos` (viewport coords) and
    // transformed back with `host.getBoundingClientRect().top` and
    // `host.scrollTop`. That worked in single-doc where the host IS
    // the scroll container, but broke in multi-doc — the scroll
    // container is the pane *body*, not the host, so the transform
    // collapsed all indicators near the top of the host's content.
    // Offsets sidestep the viewport coordinate space entirely.
    const positions: { insertPos: number; top: number }[] = [];
    const seen = new Set<number>();
    const pushPos = (insertPos: number, top: number): void => {
      if (seen.has(insertPos)) return;
      seen.add(insertPos);
      positions.push({ insertPos, top });
    };
    for (const entry of collectHeadings(view.state.doc)) {
      if (entry.level > draggedLevel) continue;
      const range = computeHeadingRange(view.state.doc, entry);
      if (!range) continue;
      const id = entry.id;
      // The heading's DOM element carries `data-id`; walk the
      // offsetParent chain from there to host so we get the CSS
      // top in host's coordinate system regardless of nesting.
      let topInHost: number | null = null;
      if (id) {
        const el = view.dom.querySelector<HTMLElement>(`[data-id="${cssEscape(id)}"]`);
        if (el) topInHost = offsetTopWithin(el, host);
      }
      if (topInHost == null) {
        // Headings without a stable id (rare) fall back to
        // coordsAtPos + the viewport→host transform.
        try {
          const hostRect = host.getBoundingClientRect();
          const zoom = this.getEditorZoom();
          const coords = view.coordsAtPos(range.from);
          topInHost = (coords.top - hostRect.top) / zoom + host.scrollTop;
        } catch {
          continue;
        }
      }
      pushPos(range.from, topInHost);
    }
    // Doc-end indicator: place it at the bottom edge of PM's own
    // element (`view.dom` is the `.ProseMirror` mount). Using
    // `host.scrollHeight` here is wrong — host typically has
    // `overflow: visible`, and the spec defines scrollHeight as
    // clientHeight in that case, so the value collapses to the
    // host's box bottom instead of the real content bottom.
    const docEnd = view.state.doc.content.size;
    if (!seen.has(docEnd)) {
      const pm = view.dom as HTMLElement;
      const pmTopInHost = offsetTopWithin(pm, host);
      if (pmTopInHost != null) {
        pushPos(docEnd, pmTopInHost + pm.offsetHeight);
      } else {
        // Fallback: viewport-coord transform (same as id-less
        // heading fallback above).
        try {
          const hostRect = host.getBoundingClientRect();
          const zoom = this.getEditorZoom();
          const endCoords = view.coordsAtPos(docEnd);
          pushPos(docEnd, (endCoords.bottom - hostRect.top) / zoom + host.scrollTop);
        } catch {
          /* skip */
        }
      }
    }

    // Single-DOM append via a fragment — no layout thrash from the
    // per-iteration mutations the old loop did.
    const fragment = document.createDocumentFragment();
    for (const { insertPos, top } of positions) {
      const indicator = document.createElement('div');
      indicator.className = 'pmd-editor-drop-indicator';
      indicator.style.top = `${top}px`;
      fragment.appendChild(indicator);
      this.indicators.push({ el: indicator, insertPos });
    }
    host.appendChild(fragment);
  }

  private removeIndicators(): void {
    for (const r of this.indicators) r.el.remove();
    this.indicators = [];
  }

  // ---- Modifier-pickup mode ----

  private onKey(e: KeyboardEvent): void {
    const nowHeld = this.isPickupModifierEvent(e);
    if (nowHeld === this.pickupModifierHeld) return;
    this.pickupModifierHeld = nowHeld;
    if (nowHeld) {
      // Activated. Run an immediate hit-test from the cached pointer
      // position so the user sees the highlight without needing to
      // wiggle the mouse.
      this.refreshHoverFromCachedPointer();
    } else {
      this.removeHighlight();
      this.hovered = null;
      // Modifier released mid-drag → cancel the drag.
      if (dragController.isActive() && this.dragOriginatedHere) {
        dragController.cancel();
      }
    }
    this.applyPickupClass();
  }

  private refreshHoverFromCachedPointer(): void {
    if (this.lastClientX < 0 || this.lastClientY < 0) return;
    if (dragController.isActive()) return;
    if (!this.host) return;
    // Only do anything if the cached position is over the editor.
    const rect = this.host.getBoundingClientRect();
    if (
      this.lastClientX < rect.left ||
      this.lastClientX > rect.right ||
      this.lastClientY < rect.top ||
      this.lastClientY > rect.bottom
    ) {
      return;
    }
    const container = this.findContainerAt(this.lastClientX, this.lastClientY);
    if (!container) return;
    this.hovered = container;
    this.showHighlight(container.from, container.to);
  }

  private isPickupModifierEvent(e: KeyboardEvent): boolean {
    return e.shiftKey && e.altKey && (e.ctrlKey || e.metaKey);
  }

  private onBlur(): void {
    if (!this.pickupModifierHeld) return;
    this.pickupModifierHeld = false;
    this.removeHighlight();
    this.hovered = null;
    if (dragController.isActive() && this.dragOriginatedHere) {
      dragController.cancel();
    }
    this.applyPickupClass();
  }

  private applyPickupClass(): void {
    if (!this.host) return;
    const inPickup = this.pickupModifierHeld && !dragController.isActive();
    this.host.classList.toggle('pmd-editor-pickup-mode', inPickup);
    this.host.classList.toggle(
      'pmd-editor-dragging-mode',
      dragController.isActive() && this.dragOriginatedHere,
    );
  }

  private onHostPointerMove(e: PointerEvent): void {
    if (dragController.isActive()) return; // drag handlers take over
    if (!this.pickupModifierHeld) return;

    const container = this.findContainerAt(e.clientX, e.clientY);
    if (!container) {
      this.removeHighlight();
      this.hovered = null;
      return;
    }
    if (
      this.hovered &&
      this.hovered.from === container.from &&
      this.hovered.to === container.to
    ) {
      return; // unchanged
    }
    this.hovered = container;
    this.showHighlight(container.from, container.to);
  }

  private onHostPointerDown(e: PointerEvent): void {
    if (e.button !== 0) return;
    if (!this.pickupModifierHeld) return;
    if (dragController.isActive()) return;
    if (!this.hovered || !this.view) return;

    e.preventDefault();
    e.stopPropagation();

    const item: DragItem = {
      from: this.hovered.from,
      to: this.hovered.to,
      id: null,
      type: this.hovered.type,
      level: this.hovered.level,
      label: this.hovered.label,
    };

    this.dragOriginatedHere = true;
    this.removeHighlight();
    this.hovered = null;

    dragController.begin({ view: this.view, items: [item] });
    this.applyPickupClass();
    this.attachDragListeners();
    this.createPickupPill(item);
    this.updatePickupPill(e.clientX, e.clientY);
    dragController.dispatchHit(e.clientX, e.clientY);
  }

  // ---- Drag listeners while a text→nav drag is active ----

  private attachDragListeners(): void {
    if (this.editorPointerMoveAttached) return;
    document.addEventListener('pointermove', this.boundOnDocMove);
    document.addEventListener('pointerup', this.boundOnDocUp);
    this.editorPointerMoveAttached = true;
  }

  private detachDragListeners(): void {
    if (!this.editorPointerMoveAttached) return;
    document.removeEventListener('pointermove', this.boundOnDocMove);
    document.removeEventListener('pointerup', this.boundOnDocUp);
    this.editorPointerMoveAttached = false;
    this.removePickupPill();
  }

  private onDocPointerMoveDuringDrag(e: PointerEvent): void {
    if (!dragController.isActive()) return;
    dragController.setPointer(e.clientX, e.clientY);
    this.updatePickupPill(e.clientX, e.clientY);
    dragController.dispatchHit(e.clientX, e.clientY);
    this.maybeAutoScroll(e.clientY);
  }

  private onDocPointerUpDuringDrag(_e: PointerEvent): void {
    if (!dragController.isActive()) return;
    dragController.commit();
    // The 'end' subscriber detaches drag listeners and clears state.
  }

  private maybeAutoScroll(clientY: number): void {
    if (!this.host) return;
    const margin = 30;
    const rect = this.host.getBoundingClientRect();
    if (clientY < rect.top + margin) this.host.scrollBy({ top: -10 });
    else if (clientY > rect.bottom - margin) this.host.scrollBy({ top: 10 });
  }

  // ---- Container detection ----

  private findContainerAt(clientX: number, clientY: number): HoveredContainer | null {
    if (!this.view) return null;
    let posInfo: { pos: number; inside: number } | null = null;
    try {
      posInfo = this.view.posAtCoords({ left: clientX, top: clientY });
    } catch {
      return null;
    }
    if (!posInfo) return null;

    const doc = this.view.state.doc;
    const $pos = doc.resolve(Math.min(posInfo.pos, doc.content.size));

    // Walk depths from inner to outer; return the smallest recognized
    // container — a card, an analytic_unit, or a heading paragraph.
    for (let depth = $pos.depth; depth >= 0; depth--) {
      const node = $pos.node(depth);
      const t = node.type.name;

      if (t === 'card' || t === 'analytic_unit') {
        const from = $pos.before(depth);
        return {
          from,
          to: from + node.nodeSize,
          type: t,
          level: 4,
          label: this.firstHeadingText(node),
        };
      }

      if (t === 'pocket' || t === 'hat' || t === 'block') {
        const from = $pos.before(depth);
        const targetLevel = TYPE_TO_LEVEL[t]!;
        let to = doc.content.size;
        doc.nodesBetween(from + node.nodeSize, doc.content.size, (n, p) => {
          if (to !== doc.content.size) return false;
          const nt = n.type.name;
          if (nt in TYPE_TO_LEVEL && TYPE_TO_LEVEL[nt]! <= targetLevel) {
            to = p;
            return false;
          }
          return true;
        });
        return {
          from,
          to,
          type: t,
          level: targetLevel,
          label: node.textContent,
        };
      }
    }
    return null;
  }

  private firstHeadingText(node: import('prosemirror-model').Node): string {
    // For card/analytic_unit, the first child is the head (tag/analytic).
    const head = node.firstChild;
    return head ? head.textContent : '';
  }

  // ---- Highlight overlay ----

  private showHighlight(from: number, to: number): void {
    this.removeHighlight();
    if (!this.view || !this.host) return;
    try {
      const fromCoords = this.view.coordsAtPos(from);
      const toCoords = this.view.coordsAtPos(Math.max(from, to - 1));
      const hostRect = this.host.getBoundingClientRect();
      const zoom = this.getEditorZoom();
      const top = (fromCoords.top - hostRect.top) / zoom + this.host.scrollTop;
      const bottom = (toCoords.bottom - hostRect.top) / zoom + this.host.scrollTop;
      const box = document.createElement('div');
      box.className = 'pmd-editor-pickup-highlight';
      box.style.top = `${top}px`;
      box.style.height = `${Math.max(2, bottom - top)}px`;
      this.host.appendChild(box);
      this.highlightBox = box;
    } catch {
      /* skip — coordsAtPos can throw mid-update */
    }
  }

  private getEditorZoom(): number {
    const pct = settings.get('zoomPct');
    return pct > 0 ? pct / 100 : 1;
  }

  private removeHighlight(): void {
    if (this.highlightBox) {
      this.highlightBox.remove();
      this.highlightBox = null;
    }
  }

  // ---- Pickup pill (text-side drags get their own pill) ----

  private pickupPill: HTMLElement | null = null;

  private createPickupPill(item: DragItem): void {
    this.removePickupPill();
    const pill = document.createElement('div');
    pill.className = 'pmd-nav-pickup-pill';
    const label = item.label.trim() || `(empty ${item.type})`;
    pill.textContent = label.length > 40 ? label.slice(0, 38) + '…' : label;
    document.body.appendChild(pill);
    this.pickupPill = pill;
  }

  private updatePickupPill(x: number, y: number): void {
    if (!this.pickupPill) return;
    this.pickupPill.style.left = `${x + 12}px`;
    this.pickupPill.style.top = `${y + 12}px`;
  }

  private removePickupPill(): void {
    if (this.pickupPill) {
      this.pickupPill.remove();
      this.pickupPill = null;
    }
  }
}

/**
 * Workspace-wide singleton.
 */
export const editorDragSurface = new EditorDragSurface();

/** Sum `offsetTop` from `el` up to (but excluding) `host`. Returns the
 *  CSS top of `el` inside `host`'s coordinate system, regardless of
 *  intermediate positioned ancestors. Used by drop-indicator placement
 *  to avoid the viewport→host transform that fails when the host
 *  isn't the scroll container. */
function offsetTopWithin(el: HTMLElement, host: HTMLElement): number | null {
  let top = 0;
  let walker: HTMLElement | null = el;
  // 16 hops is a generous bound for editor DOM nesting; prevents
  // accidental infinite walks if `host` somehow isn't in `el`'s
  // offsetParent chain.
  for (let i = 0; i < 16 && walker; i++) {
    if (walker === host) return top;
    top += walker.offsetTop;
    walker = walker.offsetParent as HTMLElement | null;
  }
  return null;
}

/** Minimal CSS.escape polyfill — matches the helper in nav-panel.ts. */
function cssEscape(s: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
    return CSS.escape(s);
  }
  return s.replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`);
}
