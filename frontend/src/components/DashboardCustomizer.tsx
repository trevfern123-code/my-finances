import { CARD_LABELS, PRESET_LABELS, type CardId, type DashboardCard, type PresetId } from '../lib/dashboardLayout';

const PRESET_IDS = Object.keys(PRESET_LABELS) as PresetId[];

export function DashboardCustomizer({
  layout,
  onToggleVisibility,
  onMove,
  onApplyPreset,
  onDone,
}: {
  layout: DashboardCard[];
  onToggleVisibility: (id: CardId) => void;
  onMove: (id: CardId, direction: 'up' | 'down') => void;
  onApplyPreset: (preset: PresetId) => void;
  onDone: () => void;
}) {
  return (
    <div className="card dashboard-customizer">
      <div className="section-header">
        <h2>Customize dashboard</h2>
        <button type="button" className="link-button" onClick={onDone}>
          Done
        </button>
      </div>

      <div className="dashboard-customizer-presets">
        <span className="hint">Start from a preset:</span>
        {PRESET_IDS.map((presetId) => (
          <button
            key={presetId}
            type="button"
            className="link-button"
            onClick={() => onApplyPreset(presetId)}
          >
            {PRESET_LABELS[presetId]}
          </button>
        ))}
      </div>

      <div className="dashboard-customizer-list">
        {layout.map((card, index) => (
          <div
            key={card.id}
            className={card.visible ? 'dashboard-customizer-row' : 'dashboard-customizer-row hidden'}
          >
            <div className="budget-category-reorder">
              <button
                type="button"
                className="reorder-btn"
                disabled={index === 0}
                onClick={() => onMove(card.id, 'up')}
                aria-label={`Move ${CARD_LABELS[card.id]} up`}
              >
                ▲
              </button>
              <button
                type="button"
                className="reorder-btn"
                disabled={index === layout.length - 1}
                onClick={() => onMove(card.id, 'down')}
                aria-label={`Move ${CARD_LABELS[card.id]} down`}
              >
                ▼
              </button>
            </div>
            <span className="dashboard-customizer-label">{CARD_LABELS[card.id]}</span>
            <button type="button" className="link-button" onClick={() => onToggleVisibility(card.id)}>
              {card.visible ? 'Hide' : 'Show'}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
