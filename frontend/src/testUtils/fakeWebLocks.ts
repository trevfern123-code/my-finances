/**
 * In-memory stand-in for the Web Locks API (`navigator.locks`) for tests — jsdom does not implement
 * it. Models the semantics the app relies on: exclusive locks, granted per name in request order,
 * each callback started only after the previous holder's callback has fully settled (its returned
 * promise, if any, included), and the lock released whether the callback returns or throws. It is a
 * single-realm model: it can prove the app's code serializes correctly under the lock, not that a
 * real browser implements Web Locks correctly across tabs.
 */
export class FakeLockManager {
  private tails = new Map<string, Promise<void>>();
  /** Names in the order `request` was called, for assertions. */
  readonly requested: string[] = [];

  request<T>(name: string, callback: () => T | Promise<T>): Promise<T> {
    this.requested.push(name);
    const previous = this.tails.get(name) ?? Promise.resolve();
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.tails.set(name, previous.then(() => released));
    return previous.then(async () => {
      try {
        return await callback();
      } finally {
        release();
      }
    });
  }
}

export function installFakeWebLocks(): FakeLockManager {
  const manager = new FakeLockManager();
  Object.defineProperty(globalThis.navigator, 'locks', { value: manager, configurable: true, writable: true });
  return manager;
}

export function removeWebLocks(): void {
  Object.defineProperty(globalThis.navigator, 'locks', { value: undefined, configurable: true, writable: true });
}
