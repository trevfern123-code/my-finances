import { useEffect, useRef, useState } from 'react';

// A curated set covering the things budget categories and accounts most commonly need an icon
// for (food, transport, housing/bills, shopping, entertainment, health, travel, education,
// personal care, finance, pets, family, misc) — not exhaustive, since anything missing is one
// paste away via the custom-emoji input below the grid. Shared between both uses rather than
// keeping two near-identical curated lists.
export const EMOJI_OPTIONS = [
  '🍔', '🍕', '🍜', '🍱', '🍿', '☕', '🍺', '🍷', '🥗',
  '🚗', '🚕', '🚌', '🚆', '✈️', '⛽', '🅿️', '🚲', '🛵',
  '🏠', '💡', '💧', '🔥', '📶', '🛠️', '🧹',
  '🛒', '👕', '👟', '💄', '🎁', '📦',
  '🎬', '🎮', '🎵', '🎉', '📺', '🎟️',
  '💊', '🏥', '🦷', '🏋️', '🧘', '🩺',
  '🧳', '🏨', '🗺️', '⛱️',
  '🎓', '📚', '✏️',
  '💇', '🧴', '🧖',
  '💰', '💳', '🏦', '📈', '💵', '🔁',
  '🐶', '🐱', '🐾',
  '👶', '🧸',
  '📱', '⚡', '🧾', '🔧',
];

/** Light sanity-check for a pasted custom emoji, not a strict grapheme validator — this is a
 *  single-user personal finance app, not a public input surface, so trimming and a generous
 *  length cap (enough for skin-tone modifiers and short ZWJ sequences like a family emoji) is
 *  enough to keep the field from silently accepting pasted sentences. */
export function sanitizeCustomEmoji(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed || trimmed.length > 8) return null;
  return trimmed;
}

export function EmojiPicker({
  value,
  onChange,
  label,
}: {
  value: string | null;
  onChange: (emoji: string | null) => void;
  label: string;
}) {
  const [open, setOpen] = useState(false);
  const [customEmoji, setCustomEmoji] = useState('');
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handleClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [open]);

  function handleCustomSubmit(e: React.FormEvent) {
    e.preventDefault();
    const sanitized = sanitizeCustomEmoji(customEmoji);
    if (!sanitized) return;
    onChange(sanitized);
    setCustomEmoji('');
    setOpen(false);
  }

  return (
    <div className="emoji-picker" ref={ref}>
      <button
        type="button"
        className="emoji-picker-trigger"
        onClick={() => setOpen((v) => !v)}
        aria-label={label}
      >
        {value ?? '＋'}
      </button>
      {open && (
        <div className="emoji-picker-panel">
          <div className="emoji-picker-grid">
            {EMOJI_OPTIONS.map((option) => (
              <button
                key={option}
                type="button"
                className="emoji-picker-option"
                onClick={() => {
                  onChange(option);
                  setOpen(false);
                }}
              >
                {option}
              </button>
            ))}
          </div>
          <form className="emoji-picker-custom" onSubmit={handleCustomSubmit}>
            <input
              type="text"
              value={customEmoji}
              onChange={(e) => setCustomEmoji(e.target.value)}
              placeholder="Paste any emoji"
              aria-label="Custom emoji"
            />
            <button type="submit" className="link-button" disabled={!sanitizeCustomEmoji(customEmoji)}>
              Use
            </button>
          </form>
          {value && (
            <button
              type="button"
              className="link-button emoji-picker-clear"
              onClick={() => {
                onChange(null);
                setOpen(false);
              }}
            >
              Clear emoji
            </button>
          )}
        </div>
      )}
    </div>
  );
}
