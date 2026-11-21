// @vitest-environment jsdom

import React from 'react';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router';

import apiClient from '@/lib/apiClient';
import OverviewModule from './OverviewModule';

let realtimeCallback;
const outletContext = {
  server: { id: 'srv-1', name: 'Training Server', status: 'running', mods: [], ports: {} },
  serverId: 'srv-1',
  fetchServer: vi.fn(),
  handleServerAction: vi.fn(),
  actionLoading: null,
  canManage: true,
  user: { id: 'admin-1', role: 'admin' },
};

vi.mock('react-router', async () => {
  const actual = await vi.importActual('react-router');
  return { ...actual, useOutletContext: () => outletContext };
});

vi.mock('@/lib/apiClient', () => ({
  default: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));

vi.mock('@/hooks/useRealtime', () => ({
  useRealtimeTopic: (_topic, callback) => { realtimeCallback = callback; },
}));


function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  realtimeCallback = undefined;
});

describe('OverviewModule request ordering', () => {
  it('does not let an older overview request overwrite a newer realtime refresh', async () => {
    const rounds = [
      { metrics: deferred(), incidents: deferred(), detections: deferred() },
      { metrics: deferred(), incidents: deferred(), detections: deferred() },
    ];
    const counts = { metrics: 0, incidents: 0, detections: 0 };
    apiClient.get.mockImplementation((url) => {
      const kind = url.includes('/metrics/summary')
        ? 'metrics'
        : url.includes('/incidents') ? 'incidents' : 'detections';
      return rounds[counts[kind]++][kind].promise;
    });

    render(<MemoryRouter><OverviewModule /></MemoryRouter>);
    await act(async () => {
      realtimeCallback({ event: 'server_state', data: { server_id: 'srv-1' } });
    });

    await act(async () => {
      rounds[1].metrics.resolve({ data: { latest: { cpu_host_percent: 91 }, trend_24h: {} } });
      rounds[1].incidents.resolve({ data: { incidents: [] } });
      rounds[1].detections.resolve({ data: { detections: [] } });
    });
    expect(await screen.findByText('91.0%')).toBeInTheDocument();

    await act(async () => {
      rounds[0].metrics.resolve({ data: { latest: { cpu_host_percent: 11 }, trend_24h: {} } });
      rounds[0].incidents.resolve({ data: { incidents: [] } });
      rounds[0].detections.resolve({ data: { detections: [] } });
    });
    expect(screen.queryByText('11.0%')).not.toBeInTheDocument();
    expect(screen.getByText('91.0%')).toBeInTheDocument();
  });
});

describe('OverviewModule offline server', () => {
  it('does not show the last sample of a stopped server as a live reading', async () => {
    outletContext.server = { ...outletContext.server, status: 'stopped' };
    apiClient.get.mockImplementation((url) => Promise.resolve({
      data: url.includes('/metrics/summary')
        ? { latest: { cpu_host_percent: 42, memory_mb: 5440, uptime_seconds: 1020 }, trend_24h: {} }
        : url.includes('/incidents') ? { incidents: [] } : { detections: [] },
    }));
    try {
      render(<MemoryRouter><OverviewModule /></MemoryRouter>);
      expect(await screen.findByText('Not running')).toBeInTheDocument();
      expect(screen.queryByText('42.0%')).not.toBeInTheDocument();
      expect(screen.queryByText('5440 MB')).not.toBeInTheDocument();
      expect(screen.getByText('Server offline')).toBeInTheDocument();
    } finally {
      outletContext.server = { ...outletContext.server, status: 'running' };
    }
  });
});
