/**
 * Voice "new card" must mint a tag with a real id. `card.createAndFill()`
 * fills the required tag with default attrs (`id: null`), which is invisible to
 * the nav pane and level filter; `newCardNode` seeds a fresh id instead.
 */

import { describe, expect, it } from 'vitest';
import { schema } from '../../src/schema/index.js';
import { newCardNode } from '../../src/editor/voice/dispatch.js';

describe('voice new card', () => {
  it('creates a card whose tag carries a real (non-null) id', () => {
    const card = newCardNode(schema);
    expect(card).not.toBeNull();
    expect(card!.type.name).toBe('card');
    const tag = card!.firstChild!;
    expect(tag.type.name).toBe('tag');
    expect(typeof tag.attrs['id']).toBe('string');
    expect(tag.attrs['id']).toBeTruthy();
  });

  it('mints a distinct id each time', () => {
    const a = newCardNode(schema)!.firstChild!.attrs['id'];
    const b = newCardNode(schema)!.firstChild!.attrs['id'];
    expect(a).not.toBe(b);
  });

  it('produces a schema-valid card', () => {
    expect(() => newCardNode(schema)!.check()).not.toThrow();
  });
});
