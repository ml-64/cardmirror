/**
 * OpenRouter request/response translation (`src/editor/ai/llm.ts`).
 * The client speaks an Anthropic-shaped request internally; these pure
 * translators convert to/from OpenRouter's OpenAI-chat format.
 */
import { describe, expect, it } from 'vitest';
import {
  toOpenRouterMessages,
  parseOpenRouterReply,
  LlmError,
} from '../../src/editor/ai/llm.js';

describe('toOpenRouterMessages', () => {
  it('prepends the system prompt as a system message', () => {
    const msgs = toOpenRouterMessages({
      apiKey: 'k',
      system: 'You are helpful.',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(msgs).toEqual([
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'hi' },
    ]);
  });

  it('omits the system message when no system prompt is given', () => {
    const msgs = toOpenRouterMessages({
      apiKey: 'k',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(msgs).toEqual([{ role: 'user', content: 'hi' }]);
  });

  it('converts an image block to an image_url data URL', () => {
    const msgs = toOpenRouterMessages({
      apiKey: 'k',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
            { type: 'text', text: 'what is this?' },
          ],
        },
      ],
    });
    expect(msgs).toEqual([
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
          { type: 'text', text: 'what is this?' },
        ],
      },
    ]);
  });
});

describe('parseOpenRouterReply', () => {
  it('reads the first choice text', () => {
    const reply = parseOpenRouterReply({
      choices: [{ message: { content: 'hello' }, finish_reason: 'stop' }],
    });
    expect(reply).toEqual({ text: 'hello', stopReason: 'stop' });
  });

  it('maps finish_reason length to max_tokens', () => {
    const reply = parseOpenRouterReply({
      choices: [{ message: { content: '{partial' }, finish_reason: 'length' }],
    });
    expect(reply.stopReason).toBe('max_tokens');
  });

  it('throws a parse LlmError on empty content', () => {
    expect(() => parseOpenRouterReply({ choices: [{ message: { content: '' } }] })).toThrow(
      LlmError,
    );
  });
});
