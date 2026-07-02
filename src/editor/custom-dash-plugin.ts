/**
 * Custom dash autoformat, gated on the `customDash*` settings (default off).
 *
 * As you type the last hyphen of the configured trigger (`---` classic, or
 * `--`), it's replaced with the configured dash output (en/em dash, with or
 * without surrounding spaces). The `--` trigger fires on the second hyphen —
 * historically not offered because such a rule "could never tell a
 * forthcoming --- apart", but as an explicit setting the ambiguity is
 * resolved by the user's choice. In `--` mode the rule refuses to fire
 * mid-hyphen-run (e.g. after pasted hyphens), so it only converts a clean
 * pair.
 *
 * Word-parity revert: pressing Backspace immediately after the substitution
 * restores the literal trigger (rather than deleting a character). The pending
 * revert is tracked in plugin state and invalidated by the very next
 * transaction, so it only applies to the keystroke right after the substitution.
 */

import { Plugin, PluginKey, TextSelection } from 'prosemirror-state';
import { settings } from './settings.js';
import type { Settings } from './settings.js';

/** The literal string each dash style produces. Spaced variants use a regular
 *  space on each side. */
const DASH_OUTPUT: Record<Settings['customDashStyle'], string> = {
  en: '–',
  'en-spaced': ' – ',
  em: '—',
  'em-spaced': ' — ',
};

/** The output string for the current `customDashStyle`. Exported for tests. */
export function dashOutput(): string {
  return DASH_OUTPUT[settings.get('customDashStyle')];
}

/** A pending Backspace-revert: the dash output sits at [from, to); Backspace
 *  there restores the literal `---`. */
interface CustomDashState {
  undo: { from: number; to: number } | null;
}

type Meta = { type: 'converted'; from: number; to: number };

export const customDashKey = new PluginKey<CustomDashState>('pmd-custom-dash');

export function customDashPlugin(): Plugin<CustomDashState> {
  return new Plugin<CustomDashState>({
    key: customDashKey,
    state: {
      init: () => ({ undo: null }),
      apply(tr, prev): CustomDashState {
        const meta = tr.getMeta(customDashKey) as Meta | undefined;
        if (meta?.type === 'converted') {
          return { undo: { from: meta.from, to: meta.to } };
        }
        // Any other transaction ends the window in which Backspace reverts.
        return prev.undo === null ? prev : { undo: null };
      },
    },
    props: {
      handleTextInput(view, from, to, text) {
        if (text !== '-') return false;
        if (!settings.get('customDashEnabled')) return false;
        const { state } = view;
        const $from = state.doc.resolve(from);
        const trigger = settings.get('customDashTrigger');
        // Need trigger.length - 1 hyphens immediately before this one
        // (within the textblock) so this keystroke completes the trigger.
        const need = trigger.length - 1;
        if ($from.parentOffset < need) return false;
        if (state.doc.textBetween(from - need, from) !== '-'.repeat(need)) return false;
        // `--` mode: don't convert inside a longer hyphen run (pasted
        // hyphens, ASCII art) — only a clean pair fires.
        if (
          trigger === '--' &&
          $from.parentOffset > need &&
          state.doc.textBetween(from - need - 1, from - need) === '-'
        ) {
          return false;
        }
        const output = dashOutput();
        const start = from - need;
        // Replace the two existing hyphens + the one being typed with the output.
        const tr = state.tr.insertText(output, start, to);
        const end = start + output.length;
        tr.setSelection(TextSelection.create(tr.doc, end));
        tr.setMeta(customDashKey, { type: 'converted', from: start, to: end } satisfies Meta);
        view.dispatch(tr.scrollIntoView());
        return true;
      },
      handleKeyDown(view, event) {
        if (event.key !== 'Backspace') return false;
        if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return false;
        const st = customDashKey.getState(view.state);
        if (!st?.undo) return false;
        const { from, to } = st.undo;
        const sel = view.state.selection;
        // Only when the cursor sits exactly after the just-inserted output…
        if (!sel.empty || sel.from !== to) return false;
        // …and that text is still the configured output (defensive).
        if (view.state.doc.textBetween(from, to) !== dashOutput()) return false;
        const trigger = settings.get('customDashTrigger');
        const tr = view.state.tr.insertText(trigger, from, to);
        tr.setSelection(TextSelection.create(tr.doc, from + trigger.length));
        view.dispatch(tr.scrollIntoView());
        return true;
      },
    },
  });
}
