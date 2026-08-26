import { useEffect, useRef, useState } from 'react';
import { CATEGORY_COLOR_OPTIONS } from '../lib/categoryColors';

export function ColorPicker({
  value,
  onChange,
  label,
}: {
  value: string | null;
  onChange: (color: string | null) => void;
  label: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handleClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [open]);

  return (
    <div className="color-picker" ref={ref}>
      <button
        type="button"
        className="color-picker-trigger"
        style={value ? { background: value } : undefined}
        onClick={() => setOpen((v) => !v)}
        aria-label={label}
      />
      {open && (
        <div className="color-picker-panel">
          <div className="color-picker-grid">
            {CATEGORY_COLOR_OPTIONS.map((option) => (
              <button
                key={option}
                type="button"
                className={value === option ? 'color-picker-option active' : 'color-picker-option'}
                style={{ background: option }}
                aria-label={option}
                onClick={() => {
                  onChange(option);
                  setOpen(false);
                }}
              />
            ))}
          </div>
          {value && (
            <button
              type="button"
              className="link-button color-picker-clear"
              onClick={() => {
                onChange(null);
                setOpen(false);
              }}
            >
              Clear color
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export function ColorDot({ color }: { color: string | null }) {
  if (!color) return null;
  return <span className="color-dot" style={{ background: color }} />;
}
