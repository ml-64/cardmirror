/**
 * Auto-capitalization (auto-capitalize-plugin.ts) — the third rule on the
 * shared autocorrect engine. Two layers:
 *   - table tests over the pure decision function (capitalizationFor):
 *     sentence starts, every believability guard (abbreviations, initials,
 *     ellipses, enumeration `i`, atoms);
 *   - plugin-level: fires ONLY in tags/analytics (user decision 2026-07-13 —
 *     card bodies/cites are source excerpts, casing preserved verbatim),
 *     Backspace-revert, window semantics, marks handling.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { EditorState } from 'prosemirror-state';
import type { Plugin } from 'prosemirror-state';
import type { Node as PMNode } from 'prosemirror-model';
import { schema, newHeadingId } from '../../src/schema/index.js';
import {
  autoCapitalizePlugin,
  autoCapitalizeKey,
  capitalizationFor,
} from '../../src/editor/auto-capitalize-plugin.js';
import { settings } from '../../src/editor/settings.js';

const n = schema.nodes;
const m = schema.marks;

beforeEach(() => {
  settings.set('autoCapitalizeSentences', true);
});

describe('capitalizationFor (pure decision table)', () => {
  const FIRES: Array<[string, string]> = [
    ['extinction', 'Extinction'], // block start
    ['  padded', 'Padded'], // leading-space block start
    ['First point. second', 'Second'],
    ['Really! yes', 'Yes'],
    ['Sure? ok', 'Ok'],
    ['He said "stop!") next', 'Next'], // closers between terminator and word
    ['In 2024. the', 'The'], // digits CAN end a sentence (word commits at the caret)
    ["don't", "Don't"], // apostrophe words
    ['prefers i', 'I'], // standalone i, committed at the caret
    ['warming. munich', 'Munich'],
  ];
  for (const [before, cap] of FIRES) {
    it(`fires: ${JSON.stringify(before)} → ${cap}`, () => {
      const hit = capitalizationFor(before);
      expect(hit).not.toBeNull();
      expect(hit!.cap).toBe(cap);
    });
  }

  const SKIPS: string[] = [
    'Already Capitalized. Next', // trailing word already capitalized
    'mid sentence word', // no terminator
    'see p. 24 and vol', // no terminator before 'vol'
    'e.g. warming', // single-letter dot token (also covers i.e., U.S.)
    'J. smith', // initials
    'etc. more', // abbreviation
    'vs. china', // abbreviation
    'pp. citations', // abbreviation
    'Jan. filing', // abbreviation (month)
    'trailing... off', // ASCII ellipsis
    'word.next', // no whitespace after the period (URL/decimal shape)
    '(i', // enumeration marker
    '3.5', // trailing word starts with a digit
    '￼ word', // atom then word: atom is not sentence context
    'text￼', // trailing atom: no word to capitalize
    '"). word', // hmm—closers BEFORE the period, no token: debris, bail
  ];
  for (const before of SKIPS) {
    it(`skips: ${JSON.stringify(before)}`, () => {
      expect(capitalizationFor(before)).toBeNull();
    });
  }

  it('standalone i fires even mid-sentence', () => {
    const hit = capitalizationFor('what i');
    expect(hit).not.toBeNull();
    expect(hit!.cap).toBe('I');
  });
});

// ─── Plugin level ──────────────────────────────────────────────────
const tag = (...k: PMNode[]) => n['tag']!.create({ id: newHeadingId() }, k);
const analytic = (...k: PMNode[]) => n['analytic']!.create({ id: newHeadingId() }, k);
const cardBody = (t: string) => n['card_body']!.create(null, schema.text(t));
const citePara = (t: string) => n['cite_paragraph']!.create(null, schema.text(t));
const undertag = (t: string) => n['undertag']!.create(null, schema.text(t));

function propsOf(plugin: Plugin) {
  return plugin.props as unknown as {
    handleTextInput: (v: unknown, from: number, to: number, text: string) => boolean;
    handleKeyDown: (v: unknown, e: unknown) => boolean;
  };
}
const BS = { key: 'Backspace', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false };

/** Type `char` at the end of the textblock of type `blockName`. */
function typeAtBlockEnd(d: PMNode, blockName: string, char: string) {
  const plugin = autoCapitalizePlugin();
  let state = EditorState.create({ doc: d, plugins: [plugin] });
  const view = {
    get state() {
      return state;
    },
    dispatch(tr: unknown) {
      state = state.apply(tr as never);
    },
  };
  let end = -1;
  d.descendants((node, pos) => {
    if (node.type.name === blockName) end = pos + 1 + node.content.size;
  });
  if (end < 0) throw new Error(`no ${blockName} in doc`);
  const fired = propsOf(plugin).handleTextInput(view, end, end, char);
  if (!fired) view.dispatch(view.state.tr.insertText(char, end, end));
  return { view, plugin, fired };
}
function textOf(d: PMNode, blockName: string): string {
  let out = '';
  d.descendants((node) => {
    if (node.type.name === blockName) out = node.textContent;
  });
  return out;
}

describe('auto-capitalize plugin: scope and mechanics', () => {
  const docWith = (blocks: PMNode[]) => n['doc']!.createChecked(null, blocks);

  it('fires in a tag', () => {
    const d = docWith([n['card']!.createChecked(null, [tag(schema.text('warming real. impacts')), cardBody('b')])]);
    const { view, fired } = typeAtBlockEnd(d, 'tag', ' ');
    expect(fired).toBe(true);
    expect(textOf(view.state.doc, 'tag')).toBe('warming real. Impacts ');
  });

  it('fires in an analytic', () => {
    const d = docWith([
      n['analytic_unit']!.createChecked(null, [analytic(schema.text('extend this')), cardBody('b')]),
    ]);
    // Block start: the first word commits via the delimiter... the whole text
    // is 'extend this' — trailing word 'this' mid-sentence: no fire. Use a
    // sentence-start shape instead:
    const d2 = docWith([
      n['analytic_unit']!.createChecked(null, [analytic(schema.text('dropped. extend')), cardBody('b')]),
    ]);
    void d;
    const { view, fired } = typeAtBlockEnd(d2, 'analytic', '.');
    expect(fired).toBe(true);
    expect(textOf(view.state.doc, 'analytic')).toBe('dropped. Extend.');
  });

  for (const [blockName, make] of [
    ['card_body', () => n['card']!.createChecked(null, [tag(schema.text('T')), cardBody('quoted. source')])],
    ['cite_paragraph', () => n['card']!.createChecked(null, [tag(schema.text('T')), citePara('smith. journal'), cardBody('b')])],
    ['undertag', () => n['card']!.createChecked(null, [tag(schema.text('T')), cardBody('b'), undertag('note. here')])],
    ['paragraph', () => n['paragraph']!.create(null, schema.text('loose. text'))],
  ] as const) {
    it(`never fires in ${blockName} (source-fidelity scope)`, () => {
      const d = n['doc']!.createChecked(null, [make()]);
      const { view, fired } = typeAtBlockEnd(d, blockName, ' ');
      expect(fired).toBe(false);
      expect(textOf(view.state.doc, blockName).includes('. ')).toBe(true); // unchanged lowercase
    });
  }

  it('does nothing when the setting is off', () => {
    settings.set('autoCapitalizeSentences', false);
    const d = docWith([n['card']!.createChecked(null, [tag(schema.text('warming. impacts')), cardBody('b')])]);
    const { fired } = typeAtBlockEnd(d, 'tag', ' ');
    expect(fired).toBe(false);
  });

  it('Backspace right after reverts to the lowercase word + delimiter', () => {
    const d = docWith([n['card']!.createChecked(null, [tag(schema.text('warming. impacts')), cardBody('b')])]);
    const { view, plugin } = typeAtBlockEnd(d, 'tag', ' ');
    expect(textOf(view.state.doc, 'tag')).toBe('warming. Impacts ');
    expect(propsOf(plugin).handleKeyDown(view, BS)).toBe(true);
    expect(textOf(view.state.doc, 'tag')).toBe('warming. impacts ');
  });

  it('the revert window survives meta-only transactions', () => {
    const d = docWith([n['card']!.createChecked(null, [tag(schema.text('warming. impacts')), cardBody('b')])]);
    const { view, plugin } = typeAtBlockEnd(d, 'tag', ' ');
    view.dispatch(view.state.tr.setMeta('background-tick', true));
    expect(autoCapitalizeKey.getState(view.state)!.undo).not.toBeNull();
    expect(propsOf(plugin).handleKeyDown(view, BS)).toBe(true);
  });

  it('a uniformly-marked word capitalizes and keeps its marks', () => {
    const d = docWith([
      n['card']!.createChecked(null, [
        tag(schema.text('warming. '), schema.text('impacts', [m['highlight']!.create()])),
        cardBody('b'),
      ]),
    ]);
    const { view, fired } = typeAtBlockEnd(d, 'tag', ' ');
    expect(fired).toBe(true);
    let markedText = '';
    view.state.doc.descendants((node) => {
      if (node.isText && m['highlight']!.isInSet(node.marks)) markedText = node.text ?? '';
      return true;
    });
    // The delimiter inherits the word's marks — exactly what default typing
    // does after marked text (the caret's marks extend), so this matches the
    // no-autocapitalize behavior.
    expect(markedText).toBe('Impacts ');
  });

  it('a word with MIXED marks is skipped (partial marking would be lost)', () => {
    const d = docWith([
      n['card']!.createChecked(null, [
        tag(
          schema.text('warming. '),
          schema.text('imp', [m['highlight']!.create()]),
          schema.text('acts'),
        ),
        cardBody('b'),
      ]),
    ]);
    const { view, fired } = typeAtBlockEnd(d, 'tag', ' ');
    expect(fired).toBe(false);
    expect(textOf(view.state.doc, 'tag')).toBe('warming. impacts ');
  });

  it('a footnote atom before the word blocks capitalization (opaque context)', () => {
    const d = docWith([
      n['card']!.createChecked(null, [
        tag(schema.text('warming.'), n['footnote']!.create(), schema.text('impacts')),
        cardBody('b'),
      ]),
    ]);
    const { fired } = typeAtBlockEnd(d, 'tag', ' ');
    expect(fired).toBe(false);
  });
});
