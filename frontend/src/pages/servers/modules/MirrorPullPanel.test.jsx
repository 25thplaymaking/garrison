// @vitest-environment jsdom

import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import apiClient from '@/lib/apiClient';
import MirrorPullPanel from './MirrorPullPanel';

vi.mock('@/lib/apiClient', () => ({
  default: { get: vi.fn(), post: vi.fn() },
}));
vi.mock('@/hooks/use-toast', () => ({ toast: vi.fn() }));

const PREVIEW = {
  mod_count_before: 2,
  mod_count_after: 2,
  diff: {
    added: [{ mod_id: 'BBBBBBBBBBBBBBBB', name: 'Ops Only' }],
    removed: [{ mod_id: '69D6DB67983E6C2E', name: 'Freedom-Of-The-Zone-Map' }],
    added_count: 1,
    removed_count: 1,
    version_changed_count: 0,
    enabled_changed_count: 0,
  },
  scenario_warning: { message: 'Fun Ops runs scenario X, which comes from Freedom-Of-The-Zone-Map.' },
};

function renderPanel(extra = {}) {
  const onApplied = vi.fn();
  render(
    <MirrorPullPanel
      server={{ id: 'fun', name: 'Fun Ops' }}
      serverId="fun"
      sources={[{ id: 'ops', name: 'Operations', status: 'running', mods: [1, 2] }]}
      loadingSources={false}
      onRefreshSources={vi.fn()}
      dirty={false}
      canManage
      user={{ id: 'admin-1', role: 'admin' }}
      onApplied={onApplied}
      {...extra}
    />,
  );
  return { onApplied };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('MirrorPullPanel', () => {
  it('previews the change and warns when the scenario mod would be dropped', async () => {
    apiClient.get.mockResolvedValue({ data: PREVIEW });
    renderPanel();
    fireEvent.click(screen.getByRole('radio', { name: /Operations/ }));

    expect(await screen.findByText(/1 added/)).toBeInTheDocument();
    expect(screen.getByText(/1 removed/)).toBeInTheDocument();
    expect(screen.getByText(/comes from Freedom-Of-The-Zone-Map/)).toBeInTheDocument();
    expect(apiClient.get.mock.calls[0][0]).toContain('/servers/fun/mods/mirror-preview?source_server_id=ops');
  });

  it('pulls through the mirror-from route and refreshes the server', async () => {
    apiClient.get.mockResolvedValue({ data: PREVIEW });
    apiClient.post.mockResolvedValue({ status: 200, data: { results: [{ ok: true, mod_count: 2 }] } });
    const { onApplied } = renderPanel();
    fireEvent.click(screen.getByRole('radio', { name: /Operations/ }));
    await screen.findByText(/1 added/);

    fireEvent.click(screen.getByRole('button', { name: /Pull from Operations/ }));
    fireEvent.click(await screen.findByRole('button', { name: /Replace load order/ }));

    await waitFor(() => expect(apiClient.post).toHaveBeenCalled());
    const [url, payload] = apiClient.post.mock.calls[0];
    expect(url).toBe('/servers/fun/mods/mirror-from');
    expect(payload).toMatchObject({ source_server_id: 'ops', create_backups: true, restart_target: false });
    await waitFor(() => expect(onApplied).toHaveBeenCalled());
  });

  it('blocks a pull while this server has unsaved load-order changes', async () => {
    apiClient.get.mockResolvedValue({ data: PREVIEW });
    renderPanel({ dirty: true });
    fireEvent.click(screen.getByRole('radio', { name: /Operations/ }));
    await screen.findByText(/1 added/);
    expect(screen.getByRole('button', { name: /Pull from Operations/ })).toBeDisabled();
    expect(screen.getByText(/unsaved load-order changes/)).toBeInTheDocument();
  });
});
