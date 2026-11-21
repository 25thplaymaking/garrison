// @vitest-environment jsdom
//
// Config Health fleet console: totals, one tile per server with
// its verdict, config state and checks, and links into the server workspace.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, test, vi } from 'vitest';

import ConfigHealthConsole from './ConfigHealthConsole';

const FLEET = {
  protocol: 'Config Health',
  version: '1.0',
  totals: { online: 1, degraded: 1, down: 0, stopped: 0 },
  players: 7,
  servers: [
    {
      id: 'ops', name: 'Operations', panel_status: 'running', players: 7, max_players: 128, map: 'Everon',
      scenario: '{59AD59368755F41A}Missions/21_GM_Eden.conf', mod_count: 42,
      ports: { game: 2001, query: 17777, rcon: 19999 },
      status: { overall: 'online', score: 100, headline: 'All checks pass.', checks: [
        { id: 'container', label: 'Container', state: 'pass', detail: 'running' },
      ] },
      config: { state: 'in_sync', drift_count: 0, lint: { error: 0, warning: 0, info: 1 } },
    },
    {
      id: 'train', name: 'Training', panel_status: 'running', players: 0, max_players: 64, map: null,
      scenario: '', mod_count: 3, ports: { game: 2011, query: 17787, rcon: 20009 },
      status: { overall: 'degraded', score: 90, headline: '2 field(s) differ from the saved config.', checks: [
        { id: 'config-file', label: 'Config file', state: 'warn', detail: '2 field(s) differ' },
      ] },
      config: { state: 'drift', drift_count: 2, lint: { error: 1, warning: 0, info: 0 } },
    },
  ],
};

vi.mock('@/hooks/useApiQuery', () => ({
  useApiQuery: () => ({ data: FLEET, isLoading: false, isFetching: false, error: null, refetch: vi.fn(), dataUpdatedAt: 0 }),
}));

afterEach(cleanup);

describe('ConfigHealthConsole', () => {
  test('shows fleet totals and a tile per server', () => {
    render(<MemoryRouter><ConfigHealthConsole /></MemoryRouter>);
    expect(screen.getByText('Config Health')).toBeInTheDocument();
    expect(screen.getByText('Players').nextSibling).toHaveTextContent('7');
    const ops = screen.getByRole('heading', { name: 'Operations' }).closest('article');
    expect(within(ops).getByText('Online')).toBeInTheDocument();
    expect(within(ops).getByText('In sync')).toBeInTheDocument();
    expect(within(ops).getByText('Config health').getAttribute('href')).toBe('/servers/ops/config/health');
  });

  test('surfaces drift and lint errors on a degraded server', () => {
    render(<MemoryRouter><ConfigHealthConsole /></MemoryRouter>);
    const train = screen.getByRole('heading', { name: 'Training' }).closest('article');
    expect(within(train).getByText('Degraded')).toBeInTheDocument();
    expect(within(train).getByText('Drift (2)')).toBeInTheDocument();
    expect(within(train).getByTitle('Errors')).toHaveTextContent('1E');
    expect(within(train).getByText('2 field(s) differ from the saved config.')).toBeInTheDocument();
  });
});
