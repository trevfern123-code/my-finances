import { useState } from 'react';
import type { InstitutionRemoval, LinkedItem } from '../lib/api';
import { describeConnectionStatus, formatLastSynced } from '../lib/connectionStatus';
import type { SessionOwnership } from '../lib/sessionOwnership';
import { ConnectionControls, UnfinishedRemovals } from './ConnectionControls';
import { describeFinishedRemoval } from './RemoveInstitutionPanel';

export interface ConnectionsSettingsProps {
  items: LinkedItem[];
  unfinishedRemovals: InstitutionRemoval[];
  createRefreshCommitter: () => (items: LinkedItem[]) => void;
  captureOwnership: () => SessionOwnership;
  /** A removal finished: refresh every dataset that could have changed. */
  onConnectionsChanged: () => void;
}

/** Settings -> Connections: every linked institution with its status, account count, last sync, and
 *  its Reconnect / Remove actions (Linked Institution Management V1). */
export function ConnectionsSettings({
  items,
  unfinishedRemovals,
  createRefreshCommitter,
  captureOwnership,
  onConnectionsChanged,
}: ConnectionsSettingsProps) {
  const [notice, setNotice] = useState<string | null>(null);

  function handleRemoved(removal: InstitutionRemoval) {
    setNotice(describeFinishedRemoval(removal));
    onConnectionsChanged();
  }

  return (
    <div className="card">
      <div className="section-header">
        <h2>Connections</h2>
      </div>
      <p className="financial-prefs-intro">
        Banks linked to My Finances through Plaid. Removing one deletes everything imported from it.
      </p>
      {notice && (
        <p className="hint connection-notice" role="status">
          {notice}
        </p>
      )}
      <UnfinishedRemovals removals={unfinishedRemovals} items={items} captureOwnership={captureOwnership} onRemoved={handleRemoved} />
      {items.length === 0 ? (
        <p className="hint">No banks linked yet.</p>
      ) : (
        <ul className="connections-list">
          {items.map((item) => {
            const view = describeConnectionStatus(item.status, item.consent_expires_at);
            const lastSynced = formatLastSynced(item.last_synced_at);
            return (
              <li key={item.id} className="connection-row">
                <div className="connection-row-header">
                  <span className="connection-row-name">{item.institution_name ?? 'Unknown institution'}</span>
                  <span className={`connection-status-badge connection-status-${view.tone}`}>{view.label}</span>
                </div>
                <p className="hint">
                  {item.accounts.length} {item.accounts.length === 1 ? 'account' : 'accounts'}
                  {lastSynced && <> &middot; {lastSynced}</>}
                </p>
                <ConnectionControls
                  item={item}
                  createRefreshCommitter={createRefreshCommitter}
                  captureOwnership={captureOwnership}
                  onRemoved={handleRemoved}
                />
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
