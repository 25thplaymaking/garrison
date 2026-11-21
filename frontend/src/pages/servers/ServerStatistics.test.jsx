// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import apiClient from '@/lib/apiClient';
import ServerStatistics from './ServerStatistics';

vi.mock('@/lib/apiClient', () => ({ default: { get: vi.fn() } }));
vi.mock('@/hooks/useRealtime', () => ({ useRealtimeTopic: vi.fn() }));
vi.mock('@/components/charts/MeasuredChartContainer', () => ({ default: () => <div>Chart</div> }));
vi.mock('framer-motion', () => ({
  motion: { div: ({ children }) => <div>{children}</div> }, useReducedMotion: () => true,
}));

const servers = [
  { id: 'operations', name: 'Operations', status: 'running', ports: { game: 2001 }, config: { game: { scenarioId: 'Everon' } } },
  { id: 'training', name: 'Training', status: 'stopped' },
];
let client;
const response = (overrides = {}) => ({ data: {
  latest: { timestamp: new Date().toISOString(), uptime_seconds: 7200, player_count: 0, memory_limit_mb: 8192, ...overrides },
  metrics: [
    { timestamp: new Date().toISOString(), avg_cpu_percent: 20, avg_memory_mb: 1000, avg_ai_count: 40, avg_vehicle_count: 8, uptime_seconds: 6000, max_network_tx_bytes: 1000 },
    { timestamp: new Date().toISOString(), avg_cpu_percent: 25, avg_memory_mb: 1200, avg_ai_count: 42, avg_vehicle_count: 10, uptime_seconds: 7200, max_network_tx_bytes: 2000 },
  ],
} });

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  apiClient.get.mockReset();
  apiClient.get.mockImplementation((url) => Promise.resolve(url === '/servers' ? { data: servers } : response()));
});
afterEach(() => { cleanup(); client.clear(); });
const mount = () => render(<QueryClientProvider client={client}><MemoryRouter><ServerStatistics /></MemoryRouter></QueryClientProvider>);

test('shows raw uptime, every chart family and server details with a single metrics request', async () => {
  mount();
  expect(await screen.findByText('2h 0m')).toBeInTheDocument();
  for (const title of ['CPU & Memory', 'Active Players', 'Server FPS', 'AI & Vehicles', 'Network RX', 'Network TX', 'Player Ping', 'Uptime', 'CPU Cores Used']) {
    expect(screen.getByRole('heading', { name: title })).toBeInTheDocument();
  }
  expect(screen.getByText('Everon')).toBeInTheDocument();
  expect(screen.getAllByText('0/?')).toHaveLength(2);
  expect(screen.getByText('2001')).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Open server workspace' })).toHaveAttribute('href', '/servers/operations');
  expect(apiClient.get.mock.calls.filter(([url]) => url.includes('/metrics'))).toHaveLength(1);
  expect(apiClient.get.mock.calls.some(([url]) => url.endsWith('/summary'))).toBe(false);
});

test('selects the requested history period and distinguishes stale data', async () => {
  apiClient.get.mockImplementation((url) => Promise.resolve(url === '/servers' ? { data: servers } : response({ timestamp: '2020-01-01T00:00:00Z' })));
  mount();
  expect(await screen.findByText(/Telemetry stale/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '7 Days' }));
  await waitFor(() => expect(apiClient.get).toHaveBeenCalledWith('/servers/operations/metrics', expect.objectContaining({ params: { period: '7d', resolution: '1h' } })));
  expect(screen.getByRole('button', { name: '7 Days' })).toHaveAttribute('aria-pressed', 'true');
});

test('an older request cannot overwrite the newly selected server', async () => {
  let resolveOld;
  apiClient.get.mockImplementation((url) => {
    if (url === '/servers') return Promise.resolve({ data: servers });
    if (url.includes('operations')) return new Promise((resolve) => { resolveOld = resolve; });
    return Promise.resolve(response({ uptime_seconds: 20 }));
  });
  mount();
  fireEvent.change(await screen.findByLabelText('Server statistics'), { target: { value: 'training' } });
  expect(await screen.findByText('Offline')).toBeInTheDocument();
  await act(async () => resolveOld(response({ uptime_seconds: 36000 })));
  expect(screen.queryByText('10h 0m')).not.toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Open server workspace' })).toHaveAttribute('href', '/servers/training');
});

test('failed metrics requests show an actionable error and recover on refresh', async () => {
  apiClient.get.mockImplementation((url) => url === '/servers' ? Promise.resolve({ data: servers }) : Promise.reject(new Error('offline')));
  mount();
  expect(await screen.findByRole('alert')).toHaveTextContent('Unable to refresh statistics');
  apiClient.get.mockImplementation((url) => Promise.resolve(url === '/servers' ? { data: servers } : response({ uptime_seconds: 0 })));
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
  expect(await screen.findByText('0h 0m')).toBeInTheDocument();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

test('missing measurements stay unavailable, with an explicit empty history', async () => {
  apiClient.get.mockImplementation((url) => Promise.resolve({ data: url === '/servers' ? servers : { metrics: [], latest: null } }));
  mount();
  expect(await screen.findByText('Awaiting sample')).toBeInTheDocument();
  // One explicit notice for the empty window instead of a grid of empty charts.
  expect(screen.getByText('No samples in the last 1 day.')).toBeInTheDocument();
  expect(screen.getByText(/None have been recorded yet/)).toBeInTheDocument();
  expect(screen.queryByText('No metrics available yet')).not.toBeInTheDocument();
  expect(screen.queryByText('0h 0m')).not.toBeInTheDocument();
});

test('an empty window after the last sample offers a wider period', async () => {
  const lastSample = new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString();
  apiClient.get.mockImplementation((url) => Promise.resolve({
    data: url === '/servers' ? servers : { metrics: [], latest: { timestamp: lastSample, cpu_percent: 2.8 }, server_status: 'stopped' },
  }));
  mount();
  expect(await screen.findByText('No samples in the last 1 day.')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Show 7 days' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Show 30 days' })).toBeInTheDocument();
});
