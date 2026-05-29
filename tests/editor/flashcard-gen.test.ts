import { describe, it, expect } from 'vitest';
import {
  parseFlashcardReply,
  formatFlashcardPrompt,
  FLASHCARD_SYSTEM_PROMPT,
  type FlashcardTurn,
} from '../../src/editor/ai/flashcard-gen.js';
import type { ExplainContext } from '../../src/editor/ai/explain-context.js';

const ctx: ExplainContext = {
  selection: 'deterrence rests on credible second-strike capability',
  paragraphs: ['Full paragraph about deterrence and second-strike capability.'],
  tag: 'Nuclear deterrence is stable',
  analytic: null,
  undertags: [],
  cites: ['Waltz 1981'],
};

describe('parseFlashcardReply', () => {
  it('parses a plain Q&A object', () => {
    expect(parseFlashcardReply('{"type":"qa","front":"Q?","back":"A"}')).toEqual({
      type: 'qa',
      front: 'Q?',
      back: 'A',
    });
  });

  it('tolerates a code fence and surrounding prose', () => {
    const reply = 'Here you go:\n```json\n{"type": "qa", "front": "Why?", "back": "Because"}\n```\n';
    expect(parseFlashcardReply(reply)).toEqual({ type: 'qa', front: 'Why?', back: 'Because' });
  });

  it('parses a cloze with an empty back', () => {
    expect(parseFlashcardReply('{"type":"cloze","front":"X is {{Y}}.","back":""}')).toEqual({
      type: 'cloze',
      front: 'X is {{Y}}.',
      back: '',
    });
  });

  it('rejects a Q&A missing its answer', () => {
    expect(parseFlashcardReply('{"type":"qa","front":"Q?","back":""}')).toBeNull();
  });

  it('rejects an empty front', () => {
    expect(parseFlashcardReply('{"type":"qa","front":"  ","back":"A"}')).toBeNull();
  });

  it('rejects an unknown type and non-JSON', () => {
    expect(parseFlashcardReply('{"type":"essay","front":"Q","back":"A"}')).toBeNull();
    expect(parseFlashcardReply('sorry, I cannot')).toBeNull();
  });
});

describe('formatFlashcardPrompt', () => {
  it('includes the highlight, the tag, and the user questions as the angle', () => {
    const turns: FlashcardTurn[] = [
      { role: 'user', text: 'why is second-strike the key?' },
      { role: 'assistant', text: 'Because it removes the incentive to strike first…' },
    ];
    const out = formatFlashcardPrompt(ctx, turns);
    expect(out).toContain('deterrence rests on credible second-strike capability');
    expect(out).toContain('Nuclear deterrence is stable'); // tag surfaced
    expect(out).toContain('why is second-strike the key?'); // user angle
    expect(out).toContain("user's questions"); // angle called out
    expect(out).toContain('background only'); // AI reply demoted
    expect(out).toContain('Waltz 1981'); // cite context
  });

  it('omits the questions section when there are none', () => {
    expect(formatFlashcardPrompt(ctx, [])).not.toContain("user's questions");
  });
});

describe('FLASHCARD_SYSTEM_PROMPT', () => {
  it('names the pathology guards and the Q&A default', () => {
    expect(FLASHCARD_SYSTEM_PROMPT).toMatch(/Atomic/i);
    expect(FLASHCARD_SYSTEM_PROMPT).toMatch(/Self-contained/);
    expect(FLASHCARD_SYSTEM_PROMPT).toMatch(/default to Q&A/i);
    expect(FLASHCARD_SYSTEM_PROMPT).toMatch(/\{\{double braces\}\}/);
  });

  it('forbids compound cards and gives the binary-grading reason', () => {
    // Atomicity is the rule the user saw violated — keep it forceful.
    expect(FLASHCARD_SYSTEM_PROMPT).toMatch(/single fact or idea/i);
    expect(FLASHCARD_SYSTEM_PROMPT).toMatch(/binary Remembered\/Forgot/i);
    expect(FLASHCARD_SYSTEM_PROMPT).toMatch(/SEPARATE cards/);
  });
});
