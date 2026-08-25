import { ACCENT_LABELS, ACCENT_SWATCHES, THEME_LABELS, type AccentId, type ThemeId } from '../lib/theme';

const THEME_IDS: ThemeId[] = ['system', 'light', 'dark'];
const ACCENT_IDS: AccentId[] = ['green', 'blue', 'teal', 'indigo', 'purple', 'amber'];

export function AppearanceSettings({
  theme,
  accent,
  onSetTheme,
  onSetAccent,
}: {
  theme: ThemeId;
  accent: AccentId;
  onSetTheme: (theme: ThemeId) => void;
  onSetAccent: (accent: AccentId) => void;
}) {
  return (
    <div className="card">
      <div className="section-header">
        <h2>Appearance</h2>
      </div>

      <div className="appearance-section">
        <span className="hint">Theme</span>
        <div className="appearance-theme-options" role="radiogroup" aria-label="Theme">
          {THEME_IDS.map((id) => (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={id === theme}
              className={id === theme ? 'appearance-theme-btn active' : 'appearance-theme-btn'}
              onClick={() => onSetTheme(id)}
            >
              {THEME_LABELS[id]}
            </button>
          ))}
        </div>
      </div>

      <div className="appearance-section">
        <span className="hint">Accent color</span>
        <div className="appearance-accent-options" role="radiogroup" aria-label="Accent color">
          {ACCENT_IDS.map((id) => (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={id === accent}
              className={id === accent ? 'appearance-accent-swatch active' : 'appearance-accent-swatch'}
              style={{ background: ACCENT_SWATCHES[id] }}
              onClick={() => onSetAccent(id)}
              aria-label={ACCENT_LABELS[id]}
              title={ACCENT_LABELS[id]}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
