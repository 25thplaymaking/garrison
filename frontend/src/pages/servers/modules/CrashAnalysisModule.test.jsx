// @vitest-environment jsdom

import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router';

import apiClient from '@/lib/apiClient';
import CrashAnalysisModule from './CrashAnalysisModule';

const outletContext = {
  serverId: 'srv-1',
  canManage: true,
  fetchServer: vi.fn(),
};

vi.mock('react-router', async () => {
  const actual = await vi.importActual('react-router');
  return { ...actual, useOutletContext: () => outletContext };
});

vi.mock('@/lib/apiClient', () => ({
  default: { get: vi.fn(), post: vi.fn() },
}));

vi.mock('@/hooks/use-toast', () => ({ toast: vi.fn() }));

const ANALYSIS = {
  server_status: 'crash_loop',
  sessions: [
    { session: 'logs_2026-10-08_00-25-58', outcome: 'failed_to_start', title: 'The configured scenario is not available' },
    { session: 'logs_2026-10-08_00-10-01', outcome: 'stopped', title: null },
  ],
  diagnosis: {
    session: 'logs_2026-10-08_00-25-58',
    outcome: 'failed_to_start',
    repeat_count: 6,
    stale: false,
    noise_note: 'The last error line in the log ("ui/fonts/robotomono_msdf_28.edds   1") is noise.',
    primary: {
      kind: 'scenario_unavailable',
      title: 'The configured scenario is not available',
      summary: 'Scenario {14FA3E05012B3DEE}Missions/Freedom-Of-The-Zone-FIXXXXX.conf could not be read',
      explanation: 'The server is set to a scenario none of the loaded mods provide.',
      evidence: [{ file: 'console.log', line: 1145, text: 'Unable to read the mission header', context: [] }],
    },
    findings: [],
    culprits: [{
      mod_id: '69D6DB67983E6C2E',
      name: 'Freedom-Of-The-Zone-Map',
      role: 'scenario',
      in_mod_list: false,
      listed_dependents: [],
      orphan: true,
      workshop_url: 'https://reforger.armaplatform.com/workshop/69D6DB67983E6C2E',
    }],
    actions: [
      { type: 'revert_revision', revision: 57, label: 'Undo mod mirror (restore revision 57)', detail: 'Revision 58 removed a mod this failure needs.', restart: true },
      { type: 'add_mods', mod_ids: ['69D6DB67983E6C2E'], label: 'Add Freedom-Of-The-Zone-Map back to the mod list', restart: true },
    ],
    mod_updates: [],
  },
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('CrashAnalysisModule', () => {
  it('leads with the root cause, not the shutdown noise, and names the mod', async () => {
    apiClient.get.mockResolvedValue({ data: ANALYSIS });
    render(<MemoryRouter><CrashAnalysisModule /></MemoryRouter>);

    expect(await screen.findByRole('heading', { name: /configured scenario is not available/i })).toBeInTheDocument();
    expect(screen.getByText(/Same failure on the last 6 boots/)).toBeInTheDocument();
    expect(screen.getByText(/robotomono_msdf_28\.edds/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Freedom-Of-The-Zone-Map/ })).toHaveAttribute(
      'href', 'https://reforger.armaplatform.com/workshop/69D6DB67983E6C2E',
    );
    expect(apiClient.get).toHaveBeenCalledWith('/servers/srv-1/crash-analysis');
  });

  it('applies the recommended fix through the rectify route with a restart', async () => {
    apiClient.get.mockResolvedValue({ data: ANALYSIS });
    apiClient.post.mockResolvedValue({ status: 200, data: { ok: true, restart: { message: 'restarting' } } });
    render(<MemoryRouter><CrashAnalysisModule /></MemoryRouter>);

    const applyButtons = await screen.findAllByRole('button', { name: 'Apply' });
    fireEvent.click(applyButtons[0]);
    fireEvent.click(await screen.findByRole('button', { name: /Apply fix/ }));

    await waitFor(() => expect(apiClient.post).toHaveBeenCalled());
    const [url, payload] = apiClient.post.mock.calls[0];
    expect(url).toBe('/servers/srv-1/crash-analysis/rectify');
    expect(payload).toMatchObject({ type: 'revert_revision', revision: 57, restart: true, session: 'logs_2026-10-08_00-25-58' });
    await waitFor(() => expect(outletContext.fetchServer).toHaveBeenCalledWith(true));
  });

  it('hides fixes for a failure the server has since recovered from', async () => {
    apiClient.get.mockResolvedValue({
      data: {
        ...ANALYSIS,
        diagnosis: {
          ...ANALYSIS.diagnosis,
          stale: true,
          recovered_in: 'logs_2026-10-08_00-30-00',
          actions: [],
          suggested_actions_hidden: ANALYSIS.diagnosis.actions,
        },
      },
    });
    render(<MemoryRouter><CrashAnalysisModule /></MemoryRouter>);

    expect(await screen.findByText(/has come online since/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Apply' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show anyway' }));
    expect(await screen.findAllByRole('button', { name: 'Apply' })).toHaveLength(2);
  });
});
