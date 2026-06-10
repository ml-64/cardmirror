/**
 * Voice command dispatch (SPEC-voice.md §3.1, §4, §5): every verb is
 * routed through the EXISTING command layer (getRibbonCommand — the
 * same code paths as the F-keys and ribbon), never raw mark
 * application, so context resolution and docx round-trip identity are
 * inherited. Unimplemented-in-v0 verbs reject loudly (echo + earcon),
 * never half-execute.
 */
import { TextSelection } from 'prosemirror-state';
import type { EditorState, Transaction } from 'prosemirror-state';
import type { Node as PMNode, ResolvedPos } from 'prosemirror-model';
import { undo, redo } from 'prosemirror-history';
import { splitBlock } from 'prosemirror-commands';
import { settings } from '../settings.js';
import { transformDictation, capitalizeForContext } from './dictation-text.js';
import {
  getRibbonCommand,
  setHighlightColor,
  type RibbonContext,
  type RibbonCommandId,
} from '../ribbon-commands.js';
import { findQuote, collectTokens, VOICE_NEAR_RADIUS } from './align.js';
import { alignReading } from './paint-align.js';
import { matchCommandName } from './please-match.js';
import {
  voicePluginKey,
  voiceDispatcher,
  sealUtterance,
  patchVoiceState,
  type ViewLike,
} from './plugin.js';
import type { CommandArgs, PenName, VoiceEvent } from './types';

export interface VoiceUi {
  /** Tray echo of a parse; ok=false plays the rejection earcon. */
  echo(text: string, ok: boolean): void;
  /** Rejection with a usage hint ("no selection — say take …"). */
  hint(text: string): void;
}

export interface DispatchDeps {
  ribbonCtx: RibbonContext;
  ui: VoiceUi;
  /** Native clipboard paths (Electron webContents.copy/cut/paste) —
   *  full-fidelity PM slices, same as Mod-C/X/V. */
  native?: { copy(): void; cut(): void; paste(): void };
}

/** Verbs bare `again` may re-issue — navigation/step only, never
 *  destructive editing (a stale repeat must not eat content). */
const REPEATABLE = new Set([
  'next', 'last', 'move', 'extend', 'goBack', 'scratchThat', 'redoThat',
  'top', 'bottom', 'goChild',
]);

const PEN_COMMAND: Record<PenName, RibbonCommandId> = {
  underline: 'applyUnderline',
  highlight: 'applyHighlight',
  emphasis: 'applyEmphasis',
  cite: 'applyCite',
};

const STRUCTURE_COMMAND: Record<string, RibbonCommandId> = {
  pocket: 'setPocket',
  hat: 'setHat',
  block: 'setBlock',
  tag: 'setTag',
  analytic: 'setAnalytic',
  paragraph: 'clearToNormal',
};

// ---- structural helpers ----

function nodePositions(doc: PMNode, typeName: string): Array<{ pos: number; node: PMNode }> {
  const out: Array<{ pos: number; node: PMNode }> = [];
  doc.descendants((node, pos) => {
    if (node.type.name === typeName) out.push({ pos, node });
    return true;
  });
  return out;
}

function enclosing($pos: ResolvedPos, typeNames: string[]): { pos: number; node: PMNode } | null {
  for (let d = $pos.depth; d > 0; d--) {
    const node = $pos.node(d);
    if (typeNames.includes(node.type.name)) return { pos: $pos.before(d), node };
  }
  return null;
}

/** Cursor landing point inside a structural node: cards land in the tag. */
function entryPos(target: { pos: number; node: PMNode }): number {
  return target.node.type.name === 'card' ? target.pos + 2 : target.pos + 1;
}

function setCursor(view: ViewLike, dispatch: (tr: Transaction) => void, pos: number): void {
  const clamped = Math.max(0, Math.min(pos, view.state.doc.content.size));
  dispatch(
    view.state.tr
      .setSelection(TextSelection.create(view.state.doc, clamped))
      .scrollIntoView(),
  );
}

function setRange(
  view: ViewLike,
  dispatch: (tr: Transaction) => void,
  from: number,
  to: number,
): void {
  dispatch(
    view.state.tr.setSelection(TextSelection.create(view.state.doc, from, to)).scrollIntoView(),
  );
}

function sentenceRange(state: EditorState): { from: number; to: number } | null {
  const $from = state.selection.$from;
  if (!$from.parent.isTextblock) return null;
  const text = $from.parent.textContent;
  const offset = $from.parentOffset;
  const start = $from.start();
  let sFrom = 0;
  let sTo = text.length;
  const re = /[.!?]+\s+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const boundary = m.index + m[0].length;
    if (boundary <= offset) sFrom = boundary;
    else {
      sTo = m.index + m[0].trimEnd().length;
      break;
    }
  }
  return { from: start + sFrom, to: start + sTo };
}

function runRibbon(
  view: ViewLike,
  deps: DispatchDeps,
  id: RibbonCommandId,
  dispatch: (tr: Transaction) => void,
): boolean {
  return getRibbonCommand(id, deps.ribbonCtx)(view.state, dispatch);
}

function requireSelection(view: ViewLike, deps: DispatchDeps): boolean {
  if (view.state.selection.empty) {
    deps.ui.hint('no selection — say "take …" first');
    return false;
  }
  return true;
}

function applyPen(
  view: ViewLike,
  deps: DispatchDeps,
  pen: { name: PenName; color?: string },
  dispatch: (tr: Transaction) => void,
): boolean {
  if (pen.name === 'highlight' && pen.color) {
    return setHighlightColor(pen.color)(view.state, dispatch);
  }
  return runRibbon(view, deps, PEN_COMMAND[pen.name], dispatch);
}

// ---- the dispatcher ----

/**
 * Apply one command-kind VoiceEvent. All transactions go through the
 * utterance dispatcher (§8 atomicity) and the utterance is sealed
 * before returning.
 */
export function applyVoiceCommand(
  view: ViewLike,
  event: Extract<VoiceEvent, { kind: 'command' }>,
  deps: DispatchDeps,
): void {
  const dispatch = voiceDispatcher(view, event.utteranceId);
  const st = voicePluginKey.getState(view.state);
  const pen = st?.pen ?? { name: 'underline' as PenName };
  const { verb, args } = event;
  const sel = view.state.selection;
  let ok = true;
  let echoText = event.raw;

  // Any command other than `pick` dismisses a pending disambiguation —
  // the user moved on (softer than the spec's only-legal-utterances
  // rule, but never traps them).
  if (st?.pendingDisambiguation && verb !== 'pick') {
    patchVoiceState(view, { pendingDisambiguation: null });
  }

  const rememberRange = () => {
    const s = view.state.selection;
    if (!s.empty) patchVoiceState(view, { lastOpRange: { from: s.from, to: s.to } });
  };

  const alignQuote = (quote: string) => {
    // Near-first cascade (§4.1): the region around the cursor gets a
    // much looser fuzz ceiling — the decode vocabulary is built from
    // this same region, so a near match is the overwhelmingly likely
    // intent. Doc-wide fallback stays strict.
    const docSize = view.state.doc.content.size;
    const near = findQuote(view.state.doc, quote, sel.from, {
      from: Math.max(0, sel.from - VOICE_NEAR_RADIUS),
      to: Math.min(docSize, sel.from + VOICE_NEAR_RADIUS),
      maxAvgDistance: 0.45,
    });
    if (near.status === 'match') return near;
    // Near pass ambiguous → re-scan doc-wide at the same looseness so
    // the badge list includes every comparable match the user can see,
    // not just those inside the near window. Near pass empty → strict
    // doc-wide (loose far matches are usually garbage).
    return findQuote(view.state.doc, quote, sel.from, {
      maxAvgDistance: near.status === 'ambiguous' ? 0.45 : undefined,
    });
  };

  /** Execute a quote-taking operation against a RESOLVED range — shared
   *  by direct matches and `pick <n>` completions. */
  const runQuoteOp = (qVerb: string, qArgs: CommandArgs, range: { from: number; to: number }): boolean => {
    switch (qVerb) {
      case 'goTo':
        setCursor(view, dispatch, range.from);
        return true;
      case 'goAfter':
        setCursor(view, dispatch, range.to);
        return true;
      case 'takeThrough':
        setRange(view, dispatch, sel.from, range.to);
        rememberRange();
        return true;
      case 'takeBackTo':
        setRange(view, dispatch, range.from, sel.to);
        rememberRange();
        return true;
      case 'fix':
        setRange(view, dispatch, range.from, range.to);
        deps.ui.hint('selected — say retype to replace it');
        return true;
      case 'paintQuote': {
        setRange(view, dispatch, range.from, range.to);
        rememberRange();
        const inked = applyPen(view, deps, pen, dispatch);
        if (inked) setCursor(view, dispatch, range.to);
        return inked;
      }
      default: {
        // takeQuote / markQuote / deleteQuote / cutQuote / copyQuote
        setRange(view, dispatch, range.from, range.to);
        rememberRange();
        if (qVerb === 'markQuote') return applyPen(view, deps, pen, dispatch);
        if (qVerb === 'deleteQuote') {
          dispatch(view.state.tr.deleteSelection().scrollIntoView());
          return true;
        }
        if (qVerb === 'cutQuote') return nativeClip(deps, 'cut');
        if (qVerb === 'copyQuote') return nativeClip(deps, 'copy');
        return true;
      }
    }
  };

  switch (verb) {
    // Pens & marking
    case 'pen':
      patchVoiceState(view, {
        pen: { name: args.pen as PenName, color: args.color },
        appendLog: { utteranceId: event.utteranceId, kind: 'command', text: event.raw },
      });
      break;
    case 'mark':
      if ((ok = requireSelection(view, deps))) {
        ok = applyPen(view, deps, pen, dispatch);
        rememberRange();
      }
      break;
    case 'strip':
      // Toggle-off path: same command as apply — the toggles remove
      // the mark when present (spec §3.1 context resolution included).
      if ((ok = requireSelection(view, deps))) ok = applyPen(view, deps, pen, dispatch);
      break;
    case 'stripAll':
      // F12 parity, no selection guard: clearToNormal owns the cursor /
      // shadow-selection / structural-demote behavior, and selection →
      // F12 deliberately no-ops on structural formatting (owner call,
      // 2026-06-09).
      ok = runRibbon(view, deps, 'clearToNormal', dispatch);
      break;
    case 'againBut': {
      const range = st?.lastOpRange;
      if (!range) {
        deps.ui.hint('nothing to re-apply');
        ok = false;
        break;
      }
      setRange(view, dispatch, range.from, range.to);
      ok = applyPen(view, deps, { name: args.pen as PenName }, dispatch);
      break;
    }

    // Quote targeting (§4.1) — match runs immediately; ambiguity sets
    // numbered in-document badges and waits for `pick <n>`.
    case 'paintQuote': {
      // Karaoke commit (§6): align the whole utterance from the session
      // anchor — marking exactly the words read, skips unmarked — and
      // harden each span through the pen command layer. One utterance =
      // one undo step; `clear last` / `scratch that` reverts it.
      const session = st?.paintSession;
      if (session) {
        const r = alignReading(paintTokens(view, session.anchor), args.quote ?? '', session.anchor);
        if (r.spans.length) {
          for (const span of r.spans) {
            setRange(view, dispatch, span.from, span.to);
            if (!applyPen(view, deps, pen, dispatch)) ok = false;
          }
          setCursor(view, dispatch, r.headPos);
          patchVoiceState(view, {
            paintSession: { anchor: r.headPos, provisional: [], headPos: r.headPos },
            lastOpRange: r.spans[r.spans.length - 1] ?? null,
          });
          echoText = `inked ${r.matched} word${r.matched === 1 ? '' : 's'}`;
          break;
        }
      }
      // Nothing aligned forward of the head (e.g. the reader jumped
      // somewhere visible): fall back to a discrete near-cursor quote.
      const fb = alignQuote(args.quote ?? '');
      const fbRange =
        fb.status === 'match'
          ? { from: fb.from, to: fb.to }
          : fb.status === 'ambiguous'
            ? fb.candidates[0] ?? null
            : null;
      if (!fbRange) {
        deps.ui.hint(`couldn't align "${args.quote}"`);
        ok = false;
        break;
      }
      ok = runQuoteOp('paintQuote', args, fbRange);
      if (ok && st?.paintSession) {
        patchVoiceState(view, {
          paintSession: { anchor: fbRange.to, provisional: [], headPos: fbRange.to },
        });
      }
      break;
    }
    case 'goTo':
    case 'goAfter':
    case 'takeQuote':
    case 'markQuote':
    case 'deleteQuote':
    case 'cutQuote':
    case 'copyQuote':
    case 'takeThrough':
    case 'takeBackTo':
    case 'fix': {
      const r = alignQuote(args.quote ?? '');
      if (r.status === 'match') {
        ok = runQuoteOp(verb, args, { from: r.from, to: r.to });
        echoText = `${event.raw}`;
      } else if (r.status === 'ambiguous') {
        patchVoiceState(view, {
          pendingDisambiguation: {
            candidates: r.candidates,
            verb,
            args: args as Record<string, unknown>,
            raw: event.raw,
          },
        });
        echoText = `«${args.quote}» ×${r.candidates.length} — say pick one–${['one', 'two', 'three', 'four'][r.candidates.length - 1]} or cancel`;
      } else {
        deps.ui.hint(`couldn't find "${args.quote}"`);
        ok = false;
      }
      break;
    }
    case 'pick': {
      const pending = st?.pendingDisambiguation;
      const range = pending?.candidates[(args.n ?? 1) - 1];
      if (!pending || !range) {
        deps.ui.hint(pending ? `only ${pending.candidates.length} choices` : 'nothing to pick');
        ok = false;
        break;
      }
      patchVoiceState(view, { pendingDisambiguation: null });
      ok = runQuoteOp(pending.verb, pending.args as CommandArgs, range);
      echoText = `${pending.raw} (${args.n})`;
      break;
    }
    case 'cardQuote': {
      // Long-range card jump: match against tag text only (§4.2).
      const tags = nodePositions(view.state.doc, 'tag');
      let best: { from: number } | null = null;
      let bestScore = Infinity;
      for (const t of tags) {
        const r = findQuote(t.node, args.quote ?? '', 0);
        if (r.status === 'match') {
          // score by tag distance from cursor; tag-internal pos ignored
          const d = Math.abs(t.pos - sel.from);
          if (d < bestScore) { bestScore = d; best = { from: t.pos + 1 }; }
        }
      }
      if (!best) { deps.ui.hint(`no card tag matches "${args.quote}"`); ok = false; break; }
      setCursor(view, dispatch, best.from);
      break;
    }

    // Structural navigation (§4.2) + text-unit steps (§4.3, 0.6.1)
    case 'next':
    case 'last': {
      const t = args.target as string;
      if (t === 'word' || t === 'letter' || t === 'sentence' || t === 'paragraph') {
        ok = textUnitStep(view, dispatch, t, verb === 'next');
        if (!ok) deps.ui.hint(`no ${verb === 'next' ? 'next' : 'previous'} ${t}`);
        break;
      }
      const positions = nodePositions(view.state.doc, args.target as string);
      const here = sel.from;
      const target =
        verb === 'next'
          ? positions.find((p) => p.pos > here)
          : [...positions].reverse().find((p) => p.pos + p.node.nodeSize < here);
      if (!target) { deps.ui.hint(`no ${verb === 'next' ? 'next' : 'previous'} ${args.target}`); ok = false; break; }
      setCursor(view, dispatch, entryPos(target));
      break;
    }
    case 'goChild': {
      const card = enclosing(sel.$from, ['card', 'analytic_unit']);
      if (!card) { deps.ui.hint('not inside a card'); ok = false; break; }
      const childType = args.target === 'cite' ? 'cite_paragraph' : args.target === 'body' ? 'card_body' : 'tag';
      let found: number | null = null;
      card.node.descendants((node, pos) => {
        if (found === null && node.type.name === childType) found = card.pos + 1 + pos + 1;
        return found === null;
      });
      if (found === null) { deps.ui.hint(`no ${args.target} in this card`); ok = false; break; }
      setCursor(view, dispatch, found);
      break;
    }
    case 'againRepeat': {
      const lastCmd = st?.lastRepeatable;
      if (!lastCmd) {
        deps.ui.hint('nothing to repeat');
        ok = false;
        break;
      }
      // Re-issue under THIS utterance's id — the repeat is its own
      // undo step and its own tray line.
      applyVoiceCommand(
        view,
        { ...event, verb: lastCmd.verb, args: lastCmd.args as CommandArgs, raw: lastCmd.raw },
        deps,
      );
      return;
    }
    case 'goBack': {
      const stack = st?.backStack ?? [];
      const target = stack[stack.length - 1];
      if (target === undefined) {
        deps.ui.hint('nowhere to go back to');
        ok = false;
        break;
      }
      const tr = view.state.tr
        .setSelection(
          TextSelection.create(view.state.doc, Math.min(target, view.state.doc.content.size)),
        )
        .scrollIntoView();
      // Consuming jump: pop the stack, and don't record this move as a
      // jump itself, so repeated `back` walks deeper instead of
      // ping-ponging.
      tr.setMeta(voicePluginKey, { popBack: true, suppressJumpRecord: true });
      dispatch(tr);
      break;
    }
    case 'top':
    case 'bottom': {
      // v0: smallest enclosing card/analytic_unit, else document ends.
      // (Heading-section fallback arrives with the nav integration.)
      const container = enclosing(sel.$from, ['card', 'analytic_unit']);
      const from = container ? container.pos + 1 : 0;
      const to = container ? container.pos + container.node.nodeSize - 1 : view.state.doc.content.size;
      setCursor(view, dispatch, verb === 'top' ? from : to);
      break;
    }

    // Selection (§4.2)
    case 'takeNode': {
      const t = args.target as string;
      if (t === 'sentence' || t === 'paragraph') {
        const r = t === 'sentence' ? sentenceRange(view.state) : (() => {
          const $f = sel.$from;
          return $f.parent.isTextblock ? { from: $f.start(), to: $f.end() } : null;
        })();
        if (!r) { deps.ui.hint('cursor is not in text'); ok = false; break; }
        setRange(view, dispatch, r.from, r.to);
        rememberRange();
        break;
      }
      const typeName = t === 'cite' ? 'cite_paragraph' : t === 'body' ? 'card_body' : t === 'unit' ? 'analytic_unit' : t;
      const container = enclosing(sel.$from, [typeName]) ??
        (t === 'tag' || t === 'cite' || t === 'body'
          ? childOfEnclosingCard(view.state, typeName)
          : null);
      if (!container) { deps.ui.hint(`not inside a ${t}`); ok = false; break; }
      setRange(view, dispatch, container.pos + 1, container.pos + container.node.nodeSize - 1);
      rememberRange();
      break;
    }
    case 'cancel':
      if (st?.pendingDisambiguation) patchVoiceState(view, { pendingDisambiguation: null });
      setCursor(view, dispatch, sel.from);
      break;

    // Cursor-relative (§4.3)
    case 'move':
    case 'extend': {
      if (args.unit === 'lines') {
        deps.ui.hint('line movement not wired yet');
        ok = false;
        break;
      }
      const tokens = collectTokens(view.state.doc, 'joined');
      const n = args.n ?? 1;
      const ref = verb === 'extend' ? sel.head : sel.from;
      let idx = tokens.findIndex((tk) => tk.from >= ref);
      if (idx < 0) idx = tokens.length;
      // move: land at the start of the nth word over.
      // extend right: land at the END of the nth word, so "extend right
      // one" visibly grows the selection through a whole word.
      let targetPos: number | undefined;
      if (args.dir === 'left') targetPos = tokens[Math.max(0, idx - n)]?.from;
      else if (verb === 'move') targetPos = tokens[Math.min(idx + n, tokens.length - 1)]?.from;
      else targetPos = tokens[Math.min(idx + n - 1, tokens.length - 1)]?.to;
      if (targetPos === undefined) { ok = false; break; }
      if (verb === 'move') setCursor(view, dispatch, targetPos);
      else dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, sel.anchor, targetPos)).scrollIntoView());
      break;
    }
    case 'cardOrdinal': {
      // §4.2.1: the badge IS the source of truth. Resolve the ordinal
      // against the nav panel's RENDERED card entries — the exact
      // elements the CSS counters number — so collapsed headers and
      // level filters can never desynchronize what you read from where
      // you land. Entries hidden under collapsed parents aren't in the
      // DOM at all.
      const navTags =
        typeof document !== 'undefined'
          ? (Array.from(
              document.querySelectorAll('.pmd-nav-panel .pmd-nav-item.pmd-nav-type-tag'),
            ) as HTMLElement[]).filter((el) => el.offsetParent !== null)
          : [];
      if (!navTags.length) {
        deps.ui.hint('card numbers follow the outline — open it, or say card <tag words>');
        ok = false;
        break;
      }
      const entryEl = navTags[(args.n ?? 1) - 1];
      const headingId = entryEl?.dataset['id'];
      if (!entryEl || !headingId) {
        deps.ui.hint(`only ${navTags.length} cards shown`);
        ok = false;
        break;
      }
      let tagPos: number | null = null;
      view.state.doc.descendants((node, pos) => {
        if (tagPos === null && node.type.name === 'tag' && node.attrs['id'] === headingId) {
          tagPos = pos;
        }
        return tagPos === null;
      });
      if (tagPos === null) {
        deps.ui.hint('that card just moved — try again');
        ok = false;
        break;
      }
      setCursor(view, dispatch, tagPos + 1);
      break;
    }

    // Editing
    case 'copy':
      if ((ok = requireSelection(view, deps))) ok = nativeClip(deps, 'copy');
      break;
    case 'cut':
      if ((ok = requireSelection(view, deps))) ok = nativeClip(deps, 'cut');
      break;
    case 'delete':
      if ((ok = requireSelection(view, deps))) dispatch(view.state.tr.deleteSelection().scrollIntoView());
      break;
    case 'paste':
      ok = nativeClip(deps, 'paste');
      break;

    // Structure
    case 'make': {
      const id = STRUCTURE_COMMAND[args.target as string];
      if (!id) { ok = false; break; }
      ok = runRibbon(view, deps, id, dispatch);
      break;
    }
    case 'newCard': {
      const cardType = view.state.schema.nodes['card'];
      const filled = cardType?.createAndFill();
      if (!filled) { ok = false; break; }
      const after = enclosing(sel.$from, ['card', 'analytic_unit']);
      const insertAt = after ? after.pos + after.node.nodeSize : sel.$from.after(1);
      const tr = view.state.tr.insert(insertAt, filled);
      tr.setSelection(TextSelection.create(tr.doc, insertAt + 2)).scrollIntoView();
      dispatch(tr);
      break;
    }
    case 'setTag':
    case 'setCite': {
      // Compound (§5): select the child's content; the service has
      // already entered dictation, so speech replaces it (§13.3).
      const childType = verb === 'setTag' ? 'tag' : 'cite_paragraph';
      const child = enclosing(sel.$from, [childType]) ?? childOfEnclosingCard(view.state, childType);
      if (!child) { deps.ui.hint(`not inside a card with a ${verb === 'setTag' ? 'tag' : 'cite'}`); ok = false; break; }
      setRange(view, dispatch, child.pos + 1, child.pos + child.node.nodeSize - 1);
      break;
    }
    case 'retype':
      if ((ok = requireSelection(view, deps))) dispatch(view.state.tr.deleteSelection());
      break;

    // Card operations
    case 'condense': ok = runRibbon(view, deps, 'condenseDefault', dispatch); break;
    case 'expand': ok = runRibbon(view, deps, 'uncondense', dispatch); break;
    case 'shrink': ok = runRibbon(view, deps, 'shrink', dispatch); break;
    case 'regrow': ok = runRibbon(view, deps, 'regrow', dispatch); break;

    // Correction (§8)
    case 'scratchThat': ok = undo(view.state, view.dispatch.bind(view)); break;
    case 'redoThat': ok = redo(view.state, view.dispatch.bind(view)); break;
    case 'clearLast': ok = undo(view.state, view.dispatch.bind(view)); break;

    // Mode/meta verbs: state changes ride the mode event; nothing to do.
    case 'startTyping':
    case 'stopTyping':
    case 'voiceSleep':
    case 'voiceWake':
      break;
    case 'newLine':
    case 'newParagraph':
      // The schema has no hard break — both split the block, same as
      // Enter.
      ok = splitBlock(view.state, dispatch);
      break;
    case 'paint':
      // Mode flip happens service-side; an explicit pen rides along
      // ("paint highlight").
      if (args.pen) patchVoiceState(view, { pen: { name: args.pen as PenName } });
      break;
    case 'stopPaint':
      break;
    case 'pressKey':
      ok = synthesizeKey(args.target as string);
      echoText = `press ${args.target}`;
      break;
    case 'typeText': {
      const input = activeUiInput();
      if (input) {
        typeIntoUiInput(input, args.quote ?? '');
      } else {
        // No UI input focused — type into the document.
        dispatch(view.state.tr.insertText(args.quote ?? '').scrollIntoView());
      }
      echoText = `type «${args.quote}»`;
      break;
    }
    case 'please': {
      // Command-palette escape hatch (§5): run any named editor command.
      const hit = matchCommandName(args.quote ?? '');
      if (!hit) {
        deps.ui.hint(`no command named "${args.quote}"`);
        ok = false;
        break;
      }
      ok = runRibbon(view, deps, hit.id, dispatch);
      if (!ok) deps.ui.hint(`"${hit.label}" can't run here`);
      echoText = `please → ${hit.label}`;
      break;
    }
    case 'tray':
    case 'more':
    case 'voiceHelp':
      break;

    default:
      deps.ui.hint(`"${verb}" not implemented yet`);
      ok = false;
  }

  sealUtterance(view);
  deps.ui.echo(echoText, ok);
  if (ok && event.raw) {
    patchVoiceState(view, {
      appendLog: { utteranceId: event.utteranceId, kind: 'command', text: echoText },
    });
  }
  if (ok && REPEATABLE.has(verb)) {
    patchVoiceState(view, {
      lastRepeatable: { verb, args: args as Record<string, unknown>, raw: echoText },
    });
  }

  function nativeClip(d: DispatchDeps, op: 'copy' | 'cut' | 'paste'): boolean {
    if (!d.native) {
      d.ui.hint(`${op} needs the desktop app`);
      return false;
    }
    d.native[op]();
    return true;
  }
}

/** Cursor step by text unit: letter / word / sentence / paragraph. */
function textUnitStep(
  view: ViewLike,
  dispatch: (tr: Transaction) => void,
  unit: 'word' | 'letter' | 'sentence' | 'paragraph',
  forward: boolean,
): boolean {
  const state = view.state;
  const head = state.selection.head;
  const docSize = state.doc.content.size;

  if (unit === 'letter') {
    const target = head + (forward ? 1 : -1);
    if (target < 0 || target > docSize) return false;
    setCursor(view, dispatch, target);
    return true;
  }
  if (unit === 'word') {
    const tokens = collectTokens(state.doc, 'joined');
    // Backward follows the Ctrl-Left convention: mid-word lands at the
    // CURRENT word's start; already at a start crosses to the previous
    // word. (A token containing the cursor has from < head, so it is
    // the last such token.)
    const target = forward
      ? tokens.find((tk) => tk.from > head)
      : [...tokens].reverse().find((tk) => tk.from < head);
    if (!target) return false;
    setCursor(view, dispatch, target.from);
    return true;
  }
  if (unit === 'paragraph') {
    const starts: number[] = [];
    state.doc.descendants((node, pos) => {
      if (node.isTextblock) {
        starts.push(pos + 1);
        return false;
      }
      return true;
    });
    // Same convention: backward = current paragraph's start when not
    // already there, else the previous paragraph's.
    const target = forward
      ? starts.find((p) => p > head)
      : [...starts].reverse().find((p) => p < head);
    if (target === undefined) return false;
    setCursor(view, dispatch, target);
    return true;
  }
  // sentence
  const range = sentenceRange(state);
  if (!range) return false;
  if (forward) {
    const next = range.to + 2;
    if (next > docSize) return false;
    setCursor(view, dispatch, Math.min(next, docSize));
    return true;
  }
  // backward: start of current sentence, or the previous one when
  // already at the start.
  if (head > range.from) {
    setCursor(view, dispatch, range.from);
    return true;
  }
  const prevProbe = range.from - 2;
  if (prevProbe <= 0) return false;
  setCursor(view, dispatch, prevProbe);
  const prevRange = sentenceRange(view.state);
  if (prevRange) setCursor(view, dispatch, prevRange.from);
  return true;
}

function childOfEnclosingCard(
  state: EditorState,
  childType: string,
): { pos: number; node: PMNode } | null {
  const card = enclosing(state.selection.$from, ['card', 'analytic_unit']);
  if (!card) return null;
  let found: { pos: number; node: PMNode } | null = null;
  card.node.descendants((node, pos) => {
    if (!found && node.type.name === childType) found = { pos: card.pos + 1 + pos, node };
    return !found;
  });
  return found;
}

// ---- UI interop: focused inputs and synthesized keys (0.6.2) ----

/** The focused text field OUTSIDE the editor (palette inputs, dialogs),
 *  or null when the document owns focus. */
export function activeUiInput(): HTMLInputElement | HTMLTextAreaElement | null {
  if (typeof document === 'undefined') return null;
  const el = document.activeElement;
  if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) return null;
  if (el.closest('.ProseMirror')) return null;
  return el;
}

/** Append text to a UI input and fire `input` so its owner reacts
 *  (palette filtering, etc.). */
export function typeIntoUiInput(el: HTMLInputElement | HTMLTextAreaElement, text: string): void {
  const sep = el.value && !/\s$/.test(el.value) ? ' ' : '';
  el.value = el.value + sep + text;
  el.dispatchEvent(new InputEvent('input', { bubbles: true }));
}

const PRESS_KEYS: Record<string, { key: string; code?: string }> = {
  enter: { key: 'Enter' },
  tab: { key: 'Tab' },
  escape: { key: 'Escape' },
  up: { key: 'ArrowUp' },
  down: { key: 'ArrowDown' },
  left: { key: 'ArrowLeft' },
  right: { key: 'ArrowRight' },
  space: { key: ' ', code: 'Space' },
  backspace: { key: 'Backspace' },
};

function synthesizeKey(target: string): boolean {
  const def = PRESS_KEYS[target];
  if (!def || typeof document === 'undefined') return false;
  const el = document.activeElement ?? document.body;
  for (const type of ['keydown', 'keyup'] as const) {
    el.dispatchEvent(
      new KeyboardEvent(type, {
        key: def.key,
        code: def.code ?? def.key,
        bubbles: true,
        cancelable: true,
      }),
    );
  }
  return true;
}

/** Token window for paint alignment: from just before the session
 *  anchor through a generous read-ahead. */
function paintTokens(view: ViewLike, anchor: number) {
  return collectTokens(
    view.state.doc,
    'joined',
    Math.max(0, anchor - 10),
    Math.min(view.state.doc.content.size, anchor + 8000),
  );
}

/** Streaming paint partial → provisional ink decorations (§6). Called
 *  by the controller on every paint-partial event; never touches the
 *  document. */
export function handlePaintPartial(view: ViewLike, text: string): void {
  const st = voicePluginKey.getState(view.state);
  const session = st?.paintSession;
  if (!session) return;
  if (!text.trim()) {
    patchVoiceState(view, { paintSession: { ...session, provisional: [] } });
    return;
  }
  const r = alignReading(paintTokens(view, session.anchor), text, session.anchor);
  patchVoiceState(view, {
    paintSession: { ...session, provisional: r.spans, headPos: r.headPos },
  });
}

/** Insert one dictation segment at the selection (replacing it). */
export function applyDictation(
  view: ViewLike,
  event: Extract<VoiceEvent, { kind: 'dictation' }>,
): void {
  const dispatch = voiceDispatcher(view, event.utteranceId);
  const sel = view.state.selection;
  // §7 transforms: spoken punctuation, the dash system, sentence
  // capitalization — then context-aware segment-start capitalization
  // and auto-spacing against the text before the insertion point.
  const context = view.state.doc.textBetween(Math.max(0, sel.from - 40), sel.from, '\n', ' ');
  let text = transformDictation(event.text, settings.get('voiceDashStyle'));
  text = capitalizeForContext(text, context);
  const before = context.slice(-1);
  const needsSpace = before !== '' && !/[\s([{«“"'—–-]$/.test(before);
  dispatch(view.state.tr.insertText((needsSpace ? ' ' : '') + text).scrollIntoView());
  sealUtterance(view);
}
