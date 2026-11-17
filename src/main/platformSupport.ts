/**
 * Centralised platform detection with documented, safe fallbacks.
 *
 * Several Kinex APIs exist only on macOS:
 *   - Electron application-menu roles such as `services`, `hide`, `hideOthers`
 *     and `unhide` (guard in `appMenu.ts`);
 *   - the `.app` bundle layout and `/usr/bin/*` tooling used by the in-app
 *     updater (guard in `macUpdater.ts`).
 *
 * Every caller must consult these helpers instead of reading `process.platform`
 * directly so Windows/Linux builds consistently take a no-op path rather than
 * invoking a native API that does not exist there. The helpers read
 * `process.platform` at call time (not cached at module load) so tests can stub
 * the platform deterministically and remain cross-platform.
 */

export type Platform = NodeJS.Platform;

/** The current runtime platform. */
export function currentPlatform(): Platform {
  return process.platform;
}

/** True only on macOS (`darwin`). */
export function isMac(): boolean {
  return currentPlatform() === 'darwin';
}

/** True only on Windows (`win32`). */
export function isWindows(): boolean {
  return currentPlatform() === 'win32';
}

/** True only on Linux (`linux`). */
export function isLinux(): boolean {
  return currentPlatform() === 'linux';
}

/**
 * Run a macOS-only operation, or return a safe fallback on every other
 * platform. `operation` is never invoked off macOS, so it cannot reach native
 * APIs that are unavailable there.
 */
export function macOnly<T>(operation: () => T, fallback: () => T): T {
  return isMac() ? operation() : fallback();
}
