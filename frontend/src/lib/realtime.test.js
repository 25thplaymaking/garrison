// @vitest-environment jsdom
// The realtime client resolves its socket URL from window.location.origin
// (see lib/realtime.js wsUrl()), so these tests need a DOM global. Without this
// pragma the suite runs under the default node environment, window is undefined,
// wsUrl() throws, and connect() silently creates no socket — failing every case.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Import the class fresh per test via module reset so singleton state
// doesn't leak between cases.
let realtimeClient;

class FakeWebSocket {
  static instances = [];

  constructor(url) {
    this.url = url;
    this.readyState = FakeWebSocket.CONNECTING;
    this.sent = [];
    FakeWebSocket.instances.push(this);
  }

  send(data) {
    this.sent.push(JSON.parse(data));
  }

  close() {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code: 1000 });
  }

  // test helpers
  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  message(payload) {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }
}
FakeWebSocket.CONNECTING = 0;
FakeWebSocket.OPEN = 1;
FakeWebSocket.CLOSED = 3;

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  FakeWebSocket.instances = [];
  vi.stubGlobal('WebSocket', FakeWebSocket);
  ({ realtimeClient } = await import('@/lib/realtime'));
});

afterEach(() => {
  realtimeClient.disconnect();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('realtimeClient', () => {
  it('connects to the /api/ws/realtime endpoint', () => {
    realtimeClient.connect();
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(FakeWebSocket.instances[0].url).toMatch(/^wss?:\/\/.+\/api\/ws\/realtime$/);
  });

  it('replays active subscriptions when the socket opens', () => {
    realtimeClient.connect();
    realtimeClient.subscribe('game', () => {});
    realtimeClient.subscribe('servers', () => {});
    const ws = FakeWebSocket.instances[0];
    ws.open();
    expect(ws.sent).toContainEqual({ type: 'SUBSCRIBE', topics: ['game', 'servers'] });
  });

  it('ref-counts topic handlers: UNSUBSCRIBE only when the last leaves', () => {
    realtimeClient.connect();
    const ws = FakeWebSocket.instances[0];
    ws.open();
    ws.sent.length = 0;

    const off1 = realtimeClient.subscribe('operations', () => {});
    const off2 = realtimeClient.subscribe('operations', () => {});
    expect(ws.sent.filter((m) => m.type === 'SUBSCRIBE')).toHaveLength(1);

    off1();
    expect(ws.sent.some((m) => m.type === 'UNSUBSCRIBE')).toBe(false);
    off2();
    expect(ws.sent.some((m) => m.type === 'UNSUBSCRIBE')).toBe(true);
  });

  it('dispatches events only to handlers for the matching topic', () => {
    realtimeClient.connect();
    const ws = FakeWebSocket.instances[0];
    ws.open();
    const opsHandler = vi.fn();
    const intelHandler = vi.fn();
    realtimeClient.subscribe('operations', opsHandler);
    realtimeClient.subscribe('intel', intelHandler);

    ws.message({ topic: 'operations', event: 'rsvp_updated', data: {} });
    ws.message({ type: 'PONG' }); // non-topic frames ignored

    expect(opsHandler).toHaveBeenCalledTimes(1);
    expect(intelHandler).not.toHaveBeenCalled();
  });

  it('reconnects with backoff after an unexpected close and notifies status', () => {
    realtimeClient.connect();
    const statuses = [];
    realtimeClient.onStatus((s) => statuses.push(s));
    const ws = FakeWebSocket.instances[0];
    ws.open();
    expect(statuses).toEqual(['connected']);

    ws.onclose({ code: 1006 }); // dropped
    expect(statuses).toEqual(['connected', 'disconnected']);

    vi.advanceTimersByTime(2_000);
    expect(FakeWebSocket.instances).toHaveLength(2);
    FakeWebSocket.instances[1].open();
    expect(statuses).toEqual(['connected', 'disconnected', 'connected']);
  });

  it('stops reconnecting after an auth rejection (4001)', () => {
    realtimeClient.connect();
    const ws = FakeWebSocket.instances[0];
    ws.open();
    ws.onclose({ code: 4001 });
    vi.advanceTimersByTime(60_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('disconnect() prevents any further reconnects', () => {
    realtimeClient.connect();
    const ws = FakeWebSocket.instances[0];
    ws.open();
    realtimeClient.disconnect();
    vi.advanceTimersByTime(60_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });
});
