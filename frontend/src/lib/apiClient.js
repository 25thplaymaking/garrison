/**
 * Shared HTTP client for all backend API calls.
 *
 * Use this instead of the bare `axios` import. The instance is preconfigured with:
 *   - baseURL pointing at the backend `/api` prefix (via `utils/api.js`)
 *   - `withCredentials: true` so the session cookie travels on every request
 *   - request interceptor placeholder for future auth headers / tracing
 *   - response interceptor that normalizes errors and surfaces 401s on a global bus
 *
 * Usage:
 *   import apiClient from '@/lib/apiClient';
 *   const { data } = await apiClient.get('/auth/me');           // → GET /api/auth/me
 *   const { data } = await apiClient.post('/servers', payload); // → POST /api/servers
 *
 * Notes:
 *   - Pass paths WITHOUT the `/api` prefix; the instance prepends it.
 *   - For URLs that need a different baseURL (third-party services, signed URLs),
 *     fall through to the raw `axios` import — the linter will flag it.
 */
import axios from 'axios';
import { API } from '@/utils/api';

export const UNAUTHORIZED_EVENT = 'apiClient:unauthorized';

/** Cancellation check for AbortController-driven requests, so consumers don't
 *  need a raw `axios` import just for the static helper. */
export const isApiCancel = (err) => axios.isCancel(err);

const apiClient = axios.create({
  baseURL: API,
  withCredentials: true,
  timeout: 30_000,
});

apiClient.interceptors.request.use((config) => config);

/** Fired with `{ available: boolean }` when the backend stops or starts answering. */
export const SITE_STATUS_EVENT = 'apiClient:site-status';

/**
 * True when the response says the site itself is down, not that one request
 * failed: nginx marks its "backend unreachable" fallback with
 * X-Site-Unavailable, and 520-530 are Cloudflare's "origin did not answer".
 * A bare network error (no response) is left alone; it is usually the
 * visitor's own connection.
 */
export function isSiteUnavailable(response) {
  if (!response) return false;
  const status = Number(response.status);
  if (status >= 520 && status <= 530) return true;
  const headers = response.headers || {};
  const marker = typeof headers.get === 'function' ? headers.get('x-site-unavailable') : headers['x-site-unavailable'];
  return status === 503 && Boolean(marker);
}

let siteUnavailable = false;
function reportSiteStatus(available) {
  if (siteUnavailable === !available || typeof window === 'undefined') return;
  siteUnavailable = !available;
  window.dispatchEvent(new CustomEvent(SITE_STATUS_EVENT, { detail: { available } }));
}

apiClient.interceptors.response.use(
  (response) => {
    reportSiteStatus(true);
    return response;
  },
  (error) => {
    const status = error?.response?.status;
    if (status === 401 && typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent(UNAUTHORIZED_EVENT, { detail: { error } }));
    }
    if (isSiteUnavailable(error?.response)) reportSiteStatus(false);
    else if (error?.response) reportSiteStatus(true);
    return Promise.reject(error);
  },
);

export default apiClient;
