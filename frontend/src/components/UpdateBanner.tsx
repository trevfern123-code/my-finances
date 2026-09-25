import { useAppUpdateSnapshot } from '../hooks/useAppUpdate';
import { appUpdate, describeUpdateBanner, type AppUpdateManager } from '../lib/appUpdate';

/**
 * The small, non-modal update notice (see lib/appUpdate.ts for the policy behind it). Read-only use
 * of the app is never blocked; when an update is required, saving is refused centrally by
 * authedFetch, and this banner explains why and how to continue.
 */
export function UpdateBanner({ manager = appUpdate }: { manager?: AppUpdateManager }) {
  const snapshot = useAppUpdateSnapshot(manager);
  const banner = describeUpdateBanner(snapshot);
  if (!banner) return null;

  const required = banner.severity === 'required';
  return (
    <div
      className={required ? 'update-banner update-banner-required' : 'update-banner'}
      role={required ? 'alert' : 'status'}
      aria-live={required ? 'assertive' : 'polite'}
    >
      <div className="update-banner-text">
        <strong>
          <span className="update-banner-label">{required ? 'Update required' : 'Update available'}:</span>{' '}
          {banner.title}
        </strong>
        <span>{banner.detail}</span>
      </div>
      <div className="update-banner-actions">
        {banner.actions.includes('reload') && (
          <button type="button" onClick={() => manager.reloadNow()}>
            Reload
          </button>
        )}
        {banner.actions.includes('discard_and_reload') && (
          <button type="button" onClick={() => manager.discardAndReload()}>
            Discard unsaved changes and reload
          </button>
        )}
      </div>
    </div>
  );
}
