// @vitest-environment jsdom

import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router';

import apiClient from '@/lib/apiClient';
import { toast } from '@/hooks/use-toast';
import ScriptBudgetModule from './ScriptBudgetModule';

vi.mock('react-router', async () => {
  const actual = await vi.importActual('react-router');
  return { ...actual, useOutletContext: () => ({ serverId: 'srv-1' }) };
});

vi.mock('@/lib/apiClient', () => ({ default: { get: vi.fn(), post: vi.fn() } }));
vi.mock('@/hooks/use-toast', () => ({ toast: vi.fn() }));

function mod(i, own, frees = own, extra = {}) {
  return {
    mod_id: `MOD${String(i).padStart(13, '0')}`,
    name: `Mod ${i}`,
    version: '1.0.0',
    listed: true,
    downloaded: true,
    own,
    frees,
    frees_mods: 1,
    needed_by: [],
    ...extra,
  };
}

const MODS = [
  mod(1, 532),
  mod(2, 429),
  mod(3, 120, 459, { frees_mods: 19 }),
  mod(4, 11, 18, { listed: false, needed_by: [{ mod_id: 'X', name: 'ACE Medical' }] }),
  ...Array.from({ length: 10 }, (_, i) => mod(10 + i, 5)),
];

const DATA = {
  mods: MODS,
  total_scripts: MODS.reduce((sum, row) => sum + row.own, 0),
  loaded_count: 14,
  listed_count: 13,
  dependency_count: 1,
  missing_count: 0,
  server_status: 'running',
};

function names() {
  return screen.getAllByRole('row').slice(1).map((row) => within(row).getByRole('link').textContent);
}

describe('ScriptBudgetModule', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('ranks the top ten by own script files and expands to all', async () => {
    apiClient.get.mockResolvedValue({ data: DATA });
    render(<MemoryRouter><ScriptBudgetModule /></MemoryRouter>);

    expect(await screen.findByText('Script Files by Mod')).toBeInTheDocument();
    expect(apiClient.get).toHaveBeenCalledWith('/servers/srv-1/script-budget');
    expect(names()).toHaveLength(10);
    expect(names().slice(0, 2)).toEqual(['Mod 1', 'Mod 2']);
    expect(screen.getByText('Dependency of ACE Medical')).toBeInTheDocument();
    expect(screen.getByText('Also takes 18 mods with it')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Show all 14'));
    expect(names()).toHaveLength(14);
  });

  it('sorts by what taking a mod off frees', async () => {
    apiClient.get.mockResolvedValue({ data: DATA });
    render(<MemoryRouter><ScriptBudgetModule /></MemoryRouter>);
    await screen.findByText('Script Files by Mod');

    fireEvent.click(screen.getByRole('button', { name: /Taking it off frees/ }));
    expect(names().slice(0, 3)).toEqual(['Mod 1', 'Mod 3', 'Mod 2']);
  });

  it('shows the API error', async () => {
    apiClient.get.mockRejectedValue({ response: { status: 500, data: { detail: 'boom' } } });
    render(<MemoryRouter><ScriptBudgetModule /></MemoryRouter>);
    expect(await screen.findByText(/boom|failed to load/i)).toBeInTheDocument();
  });

  const LIMIT = { patch_enabled: false, limit: 131072, stock_limit: 131072, patched_limit: 262144, hit: true, hit_session: 'logs_x' };

  it('offers to raise the call-target limit after a start crashed on it', async () => {
    apiClient.get.mockResolvedValue({ data: { ...DATA, call_target_limit: LIMIT } });
    apiClient.post.mockResolvedValue({ status: 200, data: { ok: true, restart: { ok: true } } });
    render(<MemoryRouter><ScriptBudgetModule /></MemoryRouter>);

    expect(await screen.findByText(/last start crashed at this limit/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Raise the limit and restart' }));

    await waitFor(() => expect(apiClient.post).toHaveBeenCalledWith(
      '/servers/srv-1/script-limit',
      { enabled: true, restart: true },
      expect.any(Object),
    ));
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Limit raised' })));
    expect(apiClient.get).toHaveBeenCalledTimes(2);
  });

  it('checks the list before launch and says players would crash', async () => {
    apiClient.get.mockResolvedValue({ data: DATA });
    apiClient.post.mockResolvedValue({
      data: { verdict: 'over_call_target_limit', checked_mods: 175, seconds: 7.4, errors: [] },
    });
    render(<MemoryRouter><ScriptBudgetModule /></MemoryRouter>);
    await screen.findByText('Script Files by Mod');

    fireEvent.click(screen.getByRole('button', { name: 'Check this list' }));

    expect(await screen.findByText('Over the call-target limit')).toBeInTheDocument();
    expect(screen.getByText(/Players crash when they join/)).toBeInTheDocument();
    expect(screen.getByText('175 mods checked in 7.4 s')).toBeInTheDocument();
    expect(apiClient.post).toHaveBeenCalledWith('/servers/srv-1/script-budget/check', {}, expect.any(Object));
  });

  it('shows the compile errors when two mods clash', async () => {
    apiClient.get.mockResolvedValue({ data: DATA });
    apiClient.post.mockResolvedValue({
      data: { verdict: 'compile_error', checked_mods: 185, seconds: 6, errors: ["Multiple declaration of class 'A'"] },
    });
    render(<MemoryRouter><ScriptBudgetModule /></MemoryRouter>);
    await screen.findByText('Script Files by Mod');

    fireEvent.click(screen.getByRole('button', { name: 'Check this list' }));

    expect(await screen.findByText('Scripts do not compile')).toBeInTheDocument();
    expect(screen.getByText("Multiple declaration of class 'A'")).toBeInTheDocument();
  });

  it('says so when the patch is on and the start still crashed', async () => {
    apiClient.get.mockResolvedValue({
      data: { ...DATA, call_target_limit: { ...LIMIT, patch_enabled: true, limit: 262144 } },
    });
    render(<MemoryRouter><ScriptBudgetModule /></MemoryRouter>);

    expect(await screen.findByText(/still crashed with the patch on/i)).toBeInTheDocument();
    expect(screen.getByText('262,144')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Turn the patch off and restart' })).toBeInTheDocument();
  });
});
