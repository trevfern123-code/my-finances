import { useState } from 'react';
import type { InstitutionRemoval, LinkedItem } from '../lib/api';
import { describeConnectionStatus } from '../lib/connectionStatus';
import type { SessionOwnership } from '../lib/sessionOwnership';
import { ReconnectButton } from './ReconnectButton';
import { RemoveInstitutionPanel } from './RemoveInstitutionPanel';

interface ConnectionActionsProps {
  createRefreshCommitter: () => (items: LinkedItem[]) => void;
  captureOwnership: () => SessionOwnership;
  /** A removal finished: the parent refreshes everything and may confirm it to the user. */
  onRemoved: (removal: InstitutionRemoval) => void;
}

/**
 * Linked Institution Management: one connection's status and actions — Reconnect (Plaid Update Mode)
 * where it can help, Remove institution, and an under-way removal's progress. Rendered on the Accounts
 * page's institution cards and in Settings -> Connections, from the same status mapping.
 */
export function ConnectionControls({ item, createRefreshCommitter, captureOwnership, onRemoved }: ConnectionActionsProps & { item: LinkedItem }) {
  const view = describeConnectionStatus(item.status, item.consent_expires_at);
  const [confirming, setConfirming] = useState(false);
  // A removal under way is always shown (and resumed, never restarted) — including after a reload.
  const removal = item.removal ?? null;
  const showPanel = confirming || item.status === 'removing' || removal !== null;

  return (
    <div className="connection-controls">
      {view.canReconnect ? (
        <ReconnectButton
          itemId={item.id}
          institutionName={item.institution_name}
          createRefreshCommitter={createRefreshCommitter}
          captureOwnership={captureOwnership}
          message={`${view.label}: ${view.description ?? ''}`}
          revoked={item.status === 'permission_revoked'}
        />
      ) : (
        item.status !== 'active' && (
          <p className={`hint connection-status connection-status-${view.tone}`}>
            <span className="connection-status-label">{view.label}</span>
            {view.description && <> &mdash; {view.description}</>}
          </p>
        )
      )}

      {showPanel ? (
        <RemoveInstitutionPanel
          itemId={item.id}
          institutionName={item.institution_name}
          existingRemoval={removal}
          captureOwnership={captureOwnership}
          onRemoved={(r) => {
            setConfirming(false);
            onRemoved(r);
          }}
          onClose={removal ? undefined : () => setConfirming(false)}
          autoFocus={confirming}
        />
      ) : (
        view.canRemove && (
          <button type="button" className="link-button remove-institution-button" onClick={() => setConfirming(true)}>
            Remove institution
          </button>
        )
      )}
    </div>
  );
}

/**
 * Removals whose institution is already gone from the list but whose final steps did not finish (the
 * data is deleted; a reports update is still pending). Without this the user could never finish them.
 */
export function UnfinishedRemovals({
  removals,
  items,
  captureOwnership,
  onRemoved,
}: {
  removals: InstitutionRemoval[];
  items: LinkedItem[];
  captureOwnership: () => SessionOwnership;
  onRemoved: (removal: InstitutionRemoval) => void;
}) {
  const present = new Set(items.map((i) => i.id));
  const orphaned = removals.filter((r) => !present.has(r.item_id) && !r.finished);
  if (orphaned.length === 0) return null;
  return (
    <div className="unfinished-removals">
      {orphaned.map((r) => (
        <RemoveInstitutionPanel
          key={r.item_id}
          itemId={r.item_id}
          institutionName={r.institution_name}
          existingRemoval={r}
          captureOwnership={captureOwnership}
          onRemoved={onRemoved}
          autoFocus={false}
        />
      ))}
    </div>
  );
}
