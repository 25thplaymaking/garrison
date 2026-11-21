/**
 * Realtime client — one WebSocket per tab, many topics.
 *
 * Counterpart of backend routes/realtime.py. Components never touch this
 * directly; they use the hooks in '@/hooks/useRealtime', which subscribe to
 * topics and land events in the TanStack Query cache.
 *
 * Behavior:
 *   - connect() is idempotent; call disconnect() on logout.
 *   - Topic subscriptions are ref-counted: SUBSCRIBE is sent when the first
 *     handler for a topic appears, UNSUBSCRIBE when the last one leaves.
 *   - Reconnects with exponential backoff + jitter (1s → 30s) and re-issues
 *     all active subscriptions; status listeners are told about 'connected'
 *     transitions so callers can refetch anything missed during the gap.
 *   - Auth rides the HttpOnly session cookie on the WS handshake (close code
 *     4001 = unauthenticated → stop reconnecting until next connect()).
 */
import { BACKEND_URL } from '@/utils/api';

const BASE_RECONNECT_MS = 1_000;
const MAX_RECONNECT_MS = 30_000;

function wsUrl() {
  const base = (BACKEND_URL || window.location.origin).replace(/\/$/, '');
  return `${base.replace(/^http/, 'ws')}/api/ws/realtime`;
}

class RealtimeClient {
  constructor() {
    this.ws = null;
    this.enabled = false;
    this.attempts = 0;
    this.reconnectTimer = null;
    this.topicHandlers = new Map(); // topic → Set<handler>
    this.statusListeners = new Set(); // handler('connected' | 'disconnected')
  }

  get connected() {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  connect() {
    if (this.enabled) return;
    this.enabled = true;
    this.attempts = 0;
    this._open();
  }

  disconnect() {
    this.enabled = false;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.close();
      this.ws = null;
    }
  }

  /** Register a handler for a topic; returns an unsubscribe function. */
  subscribe(topic, handler) {
    let handlers = this.topicHandlers.get(topic);
    if (!handlers) {
      handlers = new Set();
      this.topicHandlers.set(topic, handlers);
      this._send({ type: 'SUBSCRIBE', topics: [topic] });
    }
    handlers.add(handler);
    return () => {
      handlers.delete(handler);
      if (handlers.size === 0) {
        this.topicHandlers.delete(topic);
        this._send({ type: 'UNSUBSCRIBE', topics: [topic] });
      }
    };
  }

  /** Listen for connection-status transitions; returns an unsubscribe fn. */
  onStatus(listener) {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  // ── internals ─────────────────────────────────────────────────────────

  _open() {
    if (!this.enabled || this.connected) return;
    let ws;
    try {
      ws = new WebSocket(wsUrl());
    } catch {
      this._scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      this.attempts = 0;
      const topics = [...this.topicHandlers.keys()];
      if (topics.length) this._send({ type: 'SUBSCRIBE', topics });
      this.statusListeners.forEach((fn) => fn('connected'));
    };

    ws.onmessage = (raw) => {
      let message;
      try {
        message = JSON.parse(raw.data);
      } catch {
        return;
      }
      if (!message.topic) return; // HELLO / SUBSCRIBED / PONG
      const handlers = this.topicHandlers.get(message.topic);
      handlers?.forEach((fn) => {
        try {
          fn(message);
        } catch (err) {
          console.error('[realtime] handler error:', err);
        }
      });
    };

    ws.onclose = (event) => {
      this.ws = null;
      this.statusListeners.forEach((fn) => fn('disconnected'));
      if (event.code === 4001) {
        // Unauthenticated: reconnecting in a loop would just spam the server.
        this.enabled = false;
        return;
      }
      this._scheduleReconnect();
    };

    ws.onerror = () => {
      // onclose follows; reconnect is scheduled there.
    };
  }

  _scheduleReconnect() {
    if (!this.enabled || this.reconnectTimer) return;
    const delay = Math.min(BASE_RECONNECT_MS * 2 ** this.attempts, MAX_RECONNECT_MS);
    const jitter = delay * 0.25 * Math.random();
    this.attempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this._open();
    }, delay + jitter);
  }

  _send(message) {
    if (this.connected) {
      try {
        this.ws.send(JSON.stringify(message));
      } catch {
        // Socket raced shut; resubscribe happens on the next onopen.
      }
    }
    // Not connected: subscriptions replay from topicHandlers on open.
  }
}

export const realtimeClient = new RealtimeClient();
export default realtimeClient;
