/**
 * `React.lazy` that survives a deploy landing under an open tab.
 *
 * Every route and workspace tab in this app is code-split, so the browser
 * fetches `assets/<name>-<hash>.js` on demand. A deploy replaces those files
 * with new hashes and deletes the old ones. Any tab still holding the previous
 * `index.html` — whether it was left open or served from cache — then asks for
 * a chunk that no longer exists. The dynamic import rejects, the rejection
 * surfaces through Suspense, and ErrorBoundary shows "Rendering Error" on a
 * page whose code is perfectly fine.
 *
 * That is what a stale-chunk failure looks like from the user's side: one
 * person, one page, immediately after a release, and unreproducible for
 * everyone whose cache happens to be fresh.
 *
 * The recovery is a reload — it re-fetches `index.html` and with it the current
 * hashes. Two rules keep that honest:
 *
 *   **Only for chunk failures.** A genuine `TypeError` in a component must
 *   still reach the error boundary. Reloading on every failure would turn a
 *   real bug into a mysterious refresh loop and hide it.
 *
 *   **Once per session.** The reload is recorded in `sessionStorage` before it
 *   happens. If the very next load fails the same way, the error is rethrown
 *   and the boundary explains it, because a second reload would not have fixed
 *   anything the first one didn't.
 *
 * The server-side half of this is cache headers: `index.html` must revalidate
 * and `assets/*` may be immutable. See `nginx-production.conf`. This module is
 * the client-side safety net for the window where a tab is already open.
 */
import { lazy } from 'react';

const RELOAD_FLAG = 'chunk-reload-attempted';

// Message text differs per browser, and none of them expose a usable error
// code, so matching the wording is the only portable signal available.
const CHUNK_ERROR_PATTERNS = [
  /Failed to fetch dynamically imported module/i,
  /error loading dynamically imported module/i,
  /Importing a module script failed/i, // Safari
  /'text\/html' is not a valid JavaScript MIME type/i, // SPA fallback served HTML
  /Loading chunk \d+ failed/i,
  /ChunkLoadError/i,
];

export function isChunkLoadError(error) {
  if (!error) return false;
  const haystack = `${error.name || ''} ${error.message || error}`;
  return CHUNK_ERROR_PATTERNS.some((pattern) => pattern.test(haystack));
}

function session() {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage;
  } catch {
    // Storage can throw outright in private/blocked contexts. Treat that as
    // "no memory of a previous reload" rather than failing the import.
    return null;
  }
}

function alreadyReloaded() {
  return session()?.getItem(RELOAD_FLAG) === '1';
}

function rememberReload() {
  try {
    session()?.setItem(RELOAD_FLAG, '1');
  } catch {
    /* Without storage we simply lose the loop guard; the reload still helps. */
  }
}

export function clearChunkReloadFlag() {
  try {
    session()?.removeItem(RELOAD_FLAG);
  } catch {
    /* Nothing to clear. */
  }
}

/**
 * Wrap a dynamic import so a stale chunk recovers instead of erroring out.
 *
 * Drop-in for `lazy`: `lazyWithRetry(() => import('@/pages/Thing'))`.
 */
export function lazyWithRetry(factory) {
  return lazy(async () => {
    try {
      const mod = await factory();
      // A success means whatever went wrong is behind us; let a future deploy
      // spend its own reload.
      clearChunkReloadFlag();
      return mod;
    } catch (error) {
      if (!isChunkLoadError(error)) throw error;

      if (alreadyReloaded()) {
        // Reloading again would just loop. Let the boundary explain it.
        throw error;
      }

      rememberReload();
      if (typeof window !== 'undefined') {
        window.location.reload();
        // The reload wins the race; render nothing rather than flashing the
        // error boundary in the moment before navigation.
        return { default: () => null };
      }
      throw error;
    }
  });
}

export default lazyWithRetry;
