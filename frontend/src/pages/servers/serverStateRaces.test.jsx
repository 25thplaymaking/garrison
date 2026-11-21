// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router';

import apiClient from '@/lib/apiClient';
import ServerDashboard from './ServerDashboard';
import ServerWorkspace from './ServerWorkspace';

vi.mock('@/lib/apiClient', () => ({
  default: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));

vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'admin-1', username: 'Admin', role: 'admin' } }),
}));


vi.mock('@/components/servers/ServerCard', () => ({
  default: ({ metrics, metricsState, onPeriodChange, server }) => (
    <div data-testid="server-card">
      {server.name}:{metrics?.timeseries?.[0]?.fps ?? 'no-metrics'}
      <span data-testid={`metrics-state-${server.id}`}>{metricsState?.status || 'none'}</span>
      <button type="button" onClick={() => onPeriodChange(server.id, '7d')} aria-label={`Load 7d metrics for ${server.name}`}>
        Load 7d
      </button>
    </div>
  ),
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

function server(name, status = 'running') {
  return { id: 'srv-1', name, status, deployment_state: 'created' };
}

function renderWorkspace() {
  return render(
    <MemoryRouter initialEntries={['/servers/srv-1']}>
      <Routes>
        <Route path="/servers/:id/*" element={<ServerWorkspace />}>
          <Route index element={<div>Workspace module</div>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  // The workspace header heartbeats presence on mount and drops its row on
  // unmount. These tests are about request ordering, not presence, but a bare
  // vi.fn() returns undefined and the ambient calls would throw on `.catch`.
  apiClient.post.mockResolvedValue({ data: {} });
  apiClient.delete.mockResolvedValue({ data: {} });
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

describe('server dashboard request ordering', () => {
  test('keeps the newest dashboard list when an older refresh resolves last', async () => {
    const initial = deferred();
    const refresh = deferred();
    apiClient.get.mockImplementation((url) => {
      if (url === '/servers') return apiClient.get.mock.calls.filter(([calledUrl]) => calledUrl === '/servers').length === 1
        ? initial.promise
        : refresh.promise;
      return Promise.resolve({ data: {} });
    });

    render(<MemoryRouter><ServerDashboard /></MemoryRouter>);
    fireEvent.click(screen.getByRole('button', { name: /refresh server dashboard/i }));

    await act(async () => { refresh.resolve({ data: [server('Newest fleet')] }); });
    expect(await screen.findByText('Newest fleet:no-metrics')).toBeInTheDocument();

    await act(async () => { initial.resolve({ data: [server('Older fleet')] }); });
    await waitFor(() => expect(screen.queryByText('Older fleet:no-metrics')).not.toBeInTheDocument());
    expect(screen.getByText('Newest fleet:no-metrics')).toBeInTheDocument();
  });

  test('keeps server A metrics when a newer period request is only for server B', async () => {
    const initialMetrics = {
      'srv-1-series': deferred(),
      'srv-2-series': deferred(),
    };
    apiClient.get.mockImplementation((url, config = {}) => {
      if (url === '/servers') return Promise.resolve({ data: [server('Server A'), { ...server('Server B'), id: 'srv-2' }] });
      if (url === '/servers/srv-1/metrics') return initialMetrics['srv-1-series'].promise;
      if (url === '/servers/srv-2/metrics' && config.params?.period === '24h') return initialMetrics['srv-2-series'].promise;
      if (url === '/servers/srv-2/metrics' && config.params?.period === '7d') {
        return Promise.resolve({ data: { metrics: [{ fps: 99 }] } });
      }
      return Promise.resolve({ data: {} });
    });

    render(<MemoryRouter><ServerDashboard /></MemoryRouter>);
    expect(await screen.findByText(/Server A:no-metrics/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Load 7d metrics for Server B' }));

    await act(async () => {
      initialMetrics['srv-1-series'].resolve({ data: { latest: { fps: 10 }, metrics: [{ fps: 10 }] } });
      initialMetrics['srv-2-series'].resolve({ data: { latest: { fps: 1 }, metrics: [{ fps: 1 }] } });
    });

    expect(await screen.findByText(/Server A:10/)).toBeInTheDocument();
    expect(screen.getByText(/Server B:99/)).toBeInTheDocument();
  });

  test('polls one metrics endpoint per server without duplicating work on inventory refresh', async () => {
    vi.useFakeTimers();
    apiClient.get.mockImplementation((url) => {
      if (url === '/servers') return Promise.resolve({ data: [server('Server A')] });
      if (url === '/servers/srv-1/metrics') {
        return Promise.resolve({ data: { latest: { fps: 60 }, metrics: [{ fps: 60 }] } });
      }
      return Promise.resolve({ data: [] });
    });

    render(<MemoryRouter><ServerDashboard /></MemoryRouter>);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByText(/Server A:60/)).toBeInTheDocument();

    const metricsCalls = () => apiClient.get.mock.calls.filter(([url]) => url === '/servers/srv-1/metrics');
    expect(metricsCalls()).toHaveLength(1);
    expect(apiClient.get.mock.calls.some(([url]) => url.endsWith('/metrics/summary'))).toBe(false);

    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    expect(metricsCalls()).toHaveLength(1);

    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    expect(metricsCalls()).toHaveLength(2);
  });

  test('exposes a metrics failure as an error state instead of an empty successful response', async () => {
    apiClient.get.mockImplementation((url) => {
      if (url === '/servers') return Promise.resolve({ data: [server('Server A')] });
      if (url === '/servers/srv-1/metrics') return Promise.reject(new Error('metrics offline'));
      return Promise.resolve({ data: [] });
    });

    render(<MemoryRouter><ServerDashboard /></MemoryRouter>);

    expect(await screen.findByText('Server A:no-metrics')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('metrics-state-srv-1')).toHaveTextContent('error'));
  });

  test('unmounts fleet controls when the server section is collapsed', async () => {
    apiClient.get.mockImplementation((url) => {
      if (url === '/servers') return Promise.resolve({ data: [server('Server A')] });
      return Promise.resolve({ data: [] });
    });

    render(<MemoryRouter><ServerDashboard /></MemoryRouter>);
    await screen.findByLabelText('Search managed servers');

    const sectionToggle = screen.getByRole('button', { name: /^servers$/i });
    expect(sectionToggle).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(sectionToggle);

    expect(sectionToggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByLabelText('Search managed servers')).not.toBeInTheDocument();

    // Restore the persisted section state for the remaining dashboard tests.
    fireEvent.click(sectionToggle);
  });
});

describe('server workspace request ordering', () => {
  test('labels collapsed navigation and subordinates raw runtime identifiers', async () => {
    apiClient.get.mockImplementation((url) => {
      if (url === '/servers/srv-1') {
        return Promise.resolve({ data: { ...server('Very Long Training Server Name'), docker_image: 'registry/image:latest', container_name: 'runtime-container' } });
      }
      return Promise.resolve({ data: [] });
    });

    renderWorkspace();
    expect(await screen.findByRole('heading', { name: 'Very Long Training Server Name' })).toBeInTheDocument();
    expect(screen.getByText('Technical details')).toBeInTheDocument();

    const collapse = screen.getByRole('button', { name: 'Collapse server workspace navigation' });
    expect(collapse).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(collapse);

    expect(screen.getByRole('button', { name: 'Expand server workspace navigation' })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getAllByRole('link', { name: 'Overview' }).length).toBeGreaterThan(0);
  });

  test('keeps an authoritative full refresh when a later summary resolves last', async () => {
    vi.useFakeTimers();
    const initial = deferred();
    const fullRefresh = deferred();
    const laterSummary = deferred();
    apiClient.get.mockImplementation((url) => {
      if (url === '/servers/srv-1') {
        const fullCalls = apiClient.get.mock.calls.filter(([calledUrl]) => calledUrl === url).length;
        return fullCalls === 1 ? initial.promise : fullRefresh.promise;
      }
      if (url === '/servers/srv-1/summary') return laterSummary.promise;
      return Promise.resolve({ data: {} });
    });

    renderWorkspace();
    await act(async () => {
      initial.resolve({ data: server('Initial node') });
      await Promise.resolve();
    });
    expect(screen.getByRole('heading', { name: 'Initial node' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /refresh server/i }));
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    await act(async () => { fullRefresh.resolve({ data: server('Authoritative full response') }); });
    expect(screen.getByRole('heading', { name: 'Authoritative full response' })).toBeInTheDocument();

    await act(async () => { laterSummary.resolve({ data: { name: 'Later summary', status: 'running' } }); });
    expect(screen.queryByRole('heading', { name: 'Later summary' })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Authoritative full response' })).toBeInTheDocument();
  });

  test('does not let a summary started before a newer full refresh overwrite it', async () => {
    vi.useFakeTimers();
    const initial = deferred();
    const fullRefresh = deferred();
    const staleSummary = deferred();
    apiClient.get.mockImplementation((url) => {
      if (url === '/servers/srv-1') {
        const fullCalls = apiClient.get.mock.calls.filter(([calledUrl]) => calledUrl === url).length;
        return fullCalls === 1 ? initial.promise : fullRefresh.promise;
      }
      if (url === '/servers/srv-1/summary') return staleSummary.promise;
      return Promise.resolve({ data: {} });
    });

    renderWorkspace();
    await act(async () => {
      initial.resolve({ data: server('Initial node') });
      await Promise.resolve();
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    fireEvent.click(screen.getByRole('button', { name: /refresh server/i }));

    await act(async () => { fullRefresh.resolve({ data: server('Newer full response') }); });
    expect(screen.getByRole('heading', { name: 'Newer full response' })).toBeInTheDocument();
    await act(async () => { staleSummary.resolve({ data: { name: 'Stale summary', status: 'running' } }); });

    expect(screen.queryByRole('heading', { name: 'Stale summary' })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Newer full response' })).toBeInTheDocument();
  });

  test('resumes summary polling after the latest full refresh fails', async () => {
    vi.useFakeTimers();
    const initial = deferred();
    const failedRefresh = deferred();
    const summaryAfterFailure = deferred();
    apiClient.get.mockImplementation((url) => {
      if (url === '/servers/srv-1') {
        const fullCalls = apiClient.get.mock.calls.filter(([calledUrl]) => calledUrl === url).length;
        return fullCalls === 1 ? initial.promise : failedRefresh.promise;
      }
      if (url === '/servers/srv-1/summary') return summaryAfterFailure.promise;
      return Promise.resolve({ data: {} });
    });

    renderWorkspace();
    await act(async () => {
      initial.resolve({ data: server('Initial node') });
      await Promise.resolve();
    });
    fireEvent.click(screen.getByRole('button', { name: /refresh server/i }));
    await act(async () => { failedRefresh.reject(new Error('refresh failed')); });

    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    await act(async () => { summaryAfterFailure.resolve({ data: { name: 'Summary after failed refresh', status: 'running' } }); });

    expect(screen.getByRole('heading', { name: 'Summary after failed refresh' })).toBeInTheDocument();
  });

  test('keeps an action refresh ahead of an older manual refresh', async () => {
    const initial = deferred();
    const olderFull = deferred();
    const actionFull = deferred();
    apiClient.get.mockImplementation((url) => {
      if (url === '/servers/srv-1') {
        const fullCalls = apiClient.get.mock.calls.filter(([calledUrl]) => calledUrl === url).length;
        return [initial.promise, olderFull.promise, actionFull.promise][fullCalls - 1];
      }
      return Promise.resolve({ data: {} });
    });
    apiClient.post.mockResolvedValue({ data: { status: 'executed' } });

    renderWorkspace();
    await act(async () => { initial.resolve({ data: server('Initial node') }); });
    expect(await screen.findByRole('heading', { name: 'Initial node' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /refresh server/i }));
    fireEvent.click(screen.getByRole('button', { name: /stop server/i }));
    await waitFor(() => expect(apiClient.post).toHaveBeenCalledWith('/servers/srv-1/stop'));

    await act(async () => { actionFull.resolve({ data: server('After action', 'stopped') }); });
    expect(await screen.findByRole('heading', { name: 'After action' })).toBeInTheDocument();

    await act(async () => { olderFull.resolve({ data: server('Before action') }); });
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Before action' })).not.toBeInTheDocument());
    expect(screen.getByRole('heading', { name: 'After action' })).toBeInTheDocument();
  });
});
