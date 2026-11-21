/**
 * Shared API base-URL helpers.
 *
 * Two env-var conventions exist in the codebase:
 *   - REACT_APP_BACKEND_URL (process.env, baked in by Vite's `define` from .env)
 *   - VITE_BACKEND_URL (import.meta.env)
 * Both are accepted; REACT_APP_ wins when both are set. When neither is
 * present (local dev without a .env file, or a same-origin nginx deployment
 * where the variable was never set), we fall back to the browser's current
 * origin so that all /api/* requests still reach the backend via the reverse-proxy.
 *
 * Any new code MUST import from here rather than redefining BACKEND_URL inline.
 * `scripts/check-http-conventions.mjs` enforces this in CI.
 */

function resolveBackendUrl() {
  const fromProcess =
    typeof process !== 'undefined' &&
    process.env &&
    process.env.REACT_APP_BACKEND_URL;
  const fromImportMeta =
    typeof import.meta !== 'undefined' &&
    import.meta.env &&
    import.meta.env.VITE_BACKEND_URL;
  const fromOrigin =
    typeof window !== 'undefined' && window.location && window.location.origin;
  return fromProcess || fromImportMeta || fromOrigin || '';
}

export const BACKEND_URL = resolveBackendUrl()
  .replace(/\/$/, '')
  // Some deployments set the env var to include the /api suffix.
  // Strip it here so `${BACKEND_URL}/api/...` never produces `/api/api/...`.
  .replace(/\/api$/, '');

export const API = `${BACKEND_URL}/api`;
