// @vitest-environment jsdom
//
// Service-worker/version compatibility, phase 2: the update notice, and unsaved edits holding off an
// automatic update reload until they are saved, cancelled, or explicitly discarded.
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { appUpdate, createAppUpdateManager, LAUNCH_WINDOW_MS, type StorageLike } from '../lib/appUpdate';
import { UpdateBanner } from './UpdateBanner';
import { SplitEditor } from './SplitEditor';
import { Auth } from './Auth';

vi.mock('../lib/supabaseClient', () => ({ supabase: { auth: {} } }));

afterEach(() => {
  cleanup();
});

function manualManager() {
  let now = 1_000_000;
  const controllerListeners: Array<() => void> = [];
  const data: Record<string, string> = {};
  const storage: StorageLike = { getItem: (k) => data[k] ?? null, setItem: (k, v) => void (data[k] = v) };
  const reload = vi.fn();
  const manager = createAppUpdateManager({
    buildId: 'build-a',
    serviceWorker: {
      controller: {},
      register: () => Promise.resolve({ active: {}, update: () => Promise.resolve() }),
      addEventListener: (_t, l) => controllerListeners.push(l),
    },
    getVisibility: () => 'visible',
    onVisibilityChange: () => {},
    onPreloadError: () => {},
    reload,
    storage,
    now: () => now,
    setInterval: () => 0,
    clearInterval: () => {},
    setTimeout: () => 0,
  });
  manager.start();
  now += LAUNCH_WINDOW_MS; // past the launch window: a visible page asks rather than reloading
  return { manager, reload, newBuild: () => act(() => controllerListeners.forEach((l) => l())) };
}

describe('UpdateBanner', () => {
  it('renders nothing when there is no update', () => {
    const { manager } = manualManager();
    const { container } = render(<UpdateBanner manager={manager} />);
    expect(container.innerHTML).toBe('');
  });

  it('"A new version is ready" with a keyboard-reachable Reload button, announced politely', () => {
    const { manager, reload, newBuild } = manualManager();
    render(<UpdateBanner manager={manager} />);
    newBuild();
    const banner = screen.getByRole('status');
    expect(banner.textContent).toContain('Update available');
    expect(banner.textContent).toContain('A new version is ready.');
    const button = screen.getByRole('button', { name: 'Reload' });
    expect(button.tagName).toBe('BUTTON'); // native button: focusable, Enter/Space activate it
    fireEvent.click(button);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('"finish your current edit first" while guarded, with no reload offered', () => {
    const { manager, newBuild } = manualManager();
    const release = manager.acquireGuard('unsaved_edit');
    render(<UpdateBanner manager={manager} />);
    newBuild();
    expect(screen.getByRole('status').textContent).toContain('finish your current edit first');
    expect(screen.queryByRole('button')).toBeNull();
    act(() => release());
    expect(screen.getByRole('button', { name: 'Reload' })).toBeTruthy();
  });

  it('"Update required" is an alert, and with unsaved edits offers "Discard unsaved changes and reload"', () => {
    const { manager, reload, newBuild } = manualManager();
    const release = manager.acquireGuard('unsaved_edit');
    render(<UpdateBanner manager={manager} />);
    act(() => manager.markUpdateRequired());
    newBuild();
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('Update required');
    expect(alert.textContent).toContain("can't be saved with this version");
    fireEvent.click(screen.getByRole('button', { name: 'Discard unsaved changes and reload' }));
    expect(reload).toHaveBeenCalledTimes(1);
    release();
  });

  it('"Update required — reload to continue" when no newer build has arrived yet', () => {
    const { manager } = manualManager();
    render(<UpdateBanner manager={manager} />);
    act(() => manager.markUpdateRequired());
    expect(screen.getByRole('alert').textContent).toContain('Update required — reload to continue.');
    expect(screen.getByRole('button', { name: 'Reload' })).toBeTruthy();
  });
});

describe('unsaved edits hold the update guard', () => {
  const guards = () => appUpdate.getSnapshot().guards;

  it('SplitEditor: only once the draft differs from what it opened with, and not after unmount', () => {
    const view = render(
      <SplitEditor
        totalAmount={100}
        budgetCategories={[]}
        initialSplits={[]}
        onSave={() => Promise.resolve()}
        onClear={() => Promise.resolve()}
        onCancel={() => {}}
      />
    );
    expect(guards()).toEqual([]);
    fireEvent.change(screen.getAllByRole('spinbutton')[0], { target: { value: '40' } });
    expect(guards()).toEqual(['unsaved_edit']);
    fireEvent.change(screen.getAllByRole('spinbutton')[0], { target: { value: '' } });
    expect(guards()).toEqual([]); // back to what it opened with
    fireEvent.change(screen.getAllByRole('spinbutton')[0], { target: { value: '40' } });
    view.unmount(); // Cancel / Save closes the editor
    expect(guards()).toEqual([]);
  });

  it('Auth: typed credentials', () => {
    render(<Auth />);
    expect(guards()).toEqual([]);
    const email = document.querySelector('input[type="email"]') as HTMLInputElement;
    fireEvent.change(email, { target: { value: 'me@example.com' } });
    expect(guards()).toEqual(['unsaved_edit']);
    fireEvent.change(email, { target: { value: '' } });
    expect(guards()).toEqual([]);
  });
});
