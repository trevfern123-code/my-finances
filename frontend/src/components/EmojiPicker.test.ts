import { describe, expect, it } from 'vitest';
import { sanitizeCustomEmoji } from './EmojiPicker';

describe('sanitizeCustomEmoji', () => {
  it('accepts a single emoji', () => {
    expect(sanitizeCustomEmoji('🍔')).toBe('🍔');
  });

  it('trims surrounding whitespace', () => {
    expect(sanitizeCustomEmoji('  🎉  ')).toBe('🎉');
  });

  it('rejects an empty or whitespace-only input', () => {
    expect(sanitizeCustomEmoji('')).toBeNull();
    expect(sanitizeCustomEmoji('   ')).toBeNull();
  });

  it('accepts a multi-codepoint emoji within the length cap (e.g. a flag or ZWJ sequence)', () => {
    // Family emoji: four codepoints joined by ZWJ, well within the 8-char cap.
    expect(sanitizeCustomEmoji('👨‍👩‍👧‍👦')).toBe('👨‍👩‍👧‍👦');
  });

  it('rejects input clearly longer than a single emoji, like pasted text', () => {
    expect(sanitizeCustomEmoji('this is not an emoji')).toBeNull();
  });
});
