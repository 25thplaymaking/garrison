// @vitest-environment jsdom

import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import apiClient from '@/lib/apiClient';
import CompareServersModule from './CompareServersModule';

vi.mock('@/lib/apiClient', () => ({
  default: { get: vi.fn(), post: vi.fn() },
}));
vi.mock('@/hooks/use-toast', () => ({ toast: vi.fn() }));

const outletContext = {
  server: { id: 'ops', name: 'Operations', mods: [{ mod_id: '64DE57C0A1601D14', name: 'Lunacy Audio', enabled: true }] },
  serverId: 'ops',
  canManage: true,
  fetchServer: vi.fn(),
  user: { id: 'admin-1', role: 'admin' },
};
vi.mock('react-router', async () => {
  const actual = await vi.importActual('react-router');
  return { ...actual, useOutletContext: () => outletContext };
});

const ID = '4d5e6f7a-8b9c-4d4e-9f5a-6b7c8d9e0f1a';
const ROW = {
  id: ID, name: '[BnB2] beers an bipods', players: 128, max_players: 128, status: 'online', region: 'new_york',
  scenario: 'Everon - AAS', mod_count: 141, page_url: `https://reforgermods.net/servers/${ID}`,
};
const DETAIL = {
  ...ROW, host: '198.51.100.20', port: 2002, direct_join_code: '0053596570', battleye: true, mod_count: 2,
  mods: [
    { mod_id: '64DE57C0A1601D14', name: 'Lunacy Audio', version: '2.2.0' },
    { mod_id: '650F545AB9B7E3CD', name: 'Lunacy Overdrive', version: '1.0.1' },
  ],
};

function page(n, totalPages = 3) {
  return { data: { servers: [{ ...ROW, name: `${ROW.name} p${n}` }], page: n, total_pages: totalPages, total: 25, has_next: n < totalPages, has_prev: n > 1 } };
}

async function search(text = 'bipods') {
  fireEvent.change(screen.getByLabelText('Search public servers'), { target: { value: text } });
  fireEvent.click(screen.getByRole('button', { name: /^Search$/ }));
}

beforeEach(() => {
  apiClient.get.mockImplementation((url, { params } = {}) => (
    url === '/servers/server-list/search' ? Promise.resolve(page(params.page)) : Promise.resolve({ data: DETAIL })
  ));
  apiClient.post.mockResolvedValue({ status: 200, data: { message: 'ok' } });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('Compare / Mirror on the free server list', () => {
  it('searches modded online servers by default and pages through the results', async () => {
    render(<CompareServersModule />);
    await search();

    expect(await screen.findByText(`${ROW.name} p1`)).toBeInTheDocument();
    expect(apiClient.get).toHaveBeenCalledWith('/servers/server-list/search', {
      params: { per_page: 10, page: 1, sort: 'players', include_offline: false, modded_only: true, q: 'bipods' },
    });
    const card = screen.getByText(`${ROW.name} p1`).closest('[role="button"]');
    expect(within(card).getByText('• 141 mods')).toBeInTheDocument();
    expect(within(card).getByText('New York')).toBeInTheDocument();
    expect(screen.getByText(/Page 1 of 3 · 25 servers/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Next/ }));
    expect(await screen.findByText(`${ROW.name} p2`)).toBeInTheDocument();
    expect(apiClient.get).toHaveBeenLastCalledWith('/servers/server-list/search', {
      params: expect.objectContaining({ page: 2, q: 'bipods' }),
    });
  });

  it('says an address cannot be searched instead of pretending to look it up', async () => {
    render(<CompareServersModule />);
    fireEvent.change(screen.getByLabelText('Search public servers'), { target: { value: '198.51.100.20:2002' } });
    expect(screen.getByText(/Addresses aren.t searchable/)).toBeInTheDocument();
  });

  it('shows the picked server, marks what is installed, and mirrors its mods without version pins', async () => {
    render(<CompareServersModule />);
    await search();
    fireEvent.click(await screen.findByText(`${ROW.name} p1`));

    expect(await screen.findByText('198.51.100.20:2002')).toBeInTheDocument();
    expect(screen.getByText('0053596570')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /View/ })).toHaveAttribute('href', ROW.page_url);
    expect(screen.getByRole('link', { name: '650F545AB9B7E3CD' })).toHaveAttribute(
      'href', 'https://reforger.armaplatform.com/workshop/650F545AB9B7E3CD',
    );
    expect(screen.getByText('Already installed')).toBeInTheDocument();
    expect(screen.getByText('Not installed')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Copy all mods to this server/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Replace mod list' }));

    await waitFor(() => expect(apiClient.post).toHaveBeenCalled());
    const [url, body] = apiClient.post.mock.calls[0];
    expect(url).toBe('/servers/ops/mods/import-json');
    expect(body.mods.map((m) => [m.mod_id, m.version])).toEqual([['64DE57C0A1601D14', ''], ['650F545AB9B7E3CD', '']]);
    expect(await screen.findByText(/Successfully imported 2 mods/)).toBeInTheDocument();
  });

  it('shows the server list refusal in plain words', async () => {
    apiClient.get.mockRejectedValueOnce({ response: { status: 429, data: { detail: 'The free server list allows 60 lookups a minute and 5,000 a day from this site. Try again in a minute.' } } });
    render(<CompareServersModule />);
    await search();
    expect(await screen.findByText(/60 lookups a minute/)).toBeInTheDocument();
  });
});
