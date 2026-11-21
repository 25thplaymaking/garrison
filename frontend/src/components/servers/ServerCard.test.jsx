// @vitest-environment jsdom

import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router';

import ServerCard, { failureCause } from './ServerCard';
import { currentFailureMessage, parseServerDate } from '@/utils/serverStatus';

vi.mock('framer-motion', () => ({
  motion: {
    div: ({ children, layout: _layout, initial: _initial, animate: _animate, transition: _transition, ...props }) => (
      <div {...props}>{children}</div>
    ),
  },
  useReducedMotion: () => true,
}));

afterEach(cleanup);

describe('ServerCard deletion state', () => {
  it('shows a blocked deletion instead of collapsing it to offline', () => {
    render(
      <MemoryRouter>
        <ServerCard
          server={{
            id: 'server-2',
            name: 'Training',
            status: 'deletion_pending',
            last_docker_error: "Failed to remove server data: Permission denied: 'locked.json'",
          }}
        />
      </MemoryRouter>,
    );

    expect(screen.getByText('Deleting')).toBeInTheDocument();
    expect(screen.queryByText('Offline')).not.toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Deletion blocked');
    expect(screen.getByRole('alert')).toHaveTextContent('locked.json');
  });
});

describe('ServerCard telemetry and actions', () => {
  it('says the window is empty instead of requesting telemetry forever', () => {
    render(
      <MemoryRouter>
        <ServerCard
          server={{ id: 'server-9', name: 'Ops', status: 'stopped' }}
          metrics={{ latest: { timestamp: '2026-10-11T00:54:30Z' }, timeseries: [] }}
          metricsState={{ status: 'stale', sampledAt: '2026-10-11T00:54:30Z' }}
          period="1d"
        />
      </MemoryRouter>,
    );
    expect(screen.getByText('No samples in the last 1d - try a longer period')).toBeInTheDocument();
    expect(screen.queryByText('Requesting telemetry')).not.toBeInTheDocument();
  });

  it('renders zero uptime as a valid sample and does not show old uptime when stopped', () => {
    const props = { server: { id: 'server-6', name: 'Training', status: 'running' }, metrics: { latest: { uptime_seconds: 0 } } };
    const { rerender } = render(<MemoryRouter><ServerCard {...props} /></MemoryRouter>);
    expect(screen.getByText('0h 0m')).toBeInTheDocument();
    rerender(<MemoryRouter><ServerCard {...props} server={{ ...props.server, status: 'stopped' }} /></MemoryRouter>);
    expect(screen.getByText('Not running')).toBeInTheDocument();
    expect(screen.queryByText('0h 0m')).not.toBeInTheDocument();
  });

  it('reports a telemetry request failure instead of implying collection is in progress', () => {
    render(
      <MemoryRouter>
        <ServerCard
          server={{ id: 'server-3', name: 'Recon', status: 'stopped' }}
          metricsState={{
            status: 'error',
            checkedAt: '2026-08-30T16:00:00.000Z',
            message: 'Metrics service did not respond.',
          }}
        />
      </MemoryRouter>,
    );

    expect(screen.getByRole('alert')).toHaveTextContent('Telemetry unavailable');
    expect(screen.getByRole('alert')).toHaveTextContent('Metrics service did not respond');
    expect(screen.getByText('Telemetry is unavailable')).toBeInTheDocument();
    expect(screen.queryByText('Collecting telemetry')).not.toBeInTheDocument();
  });

  it('keeps last-known metrics visible while identifying stale telemetry', () => {
    render(
      <MemoryRouter>
        <ServerCard
          server={{ id: 'server-4', name: 'Long Range Training', status: 'running' }}
          metrics={{
            latest: { player_count: 8, fps: 58, uptime_seconds: 1800 },
            timeseries: [{ timestamp: '2026-08-30T15:00:00.000Z', fps: 58, player_count: 8 }],
          }}
          metricsState={{ status: 'stale', sampledAt: '2026-08-30T15:00:00.000Z', message: 'Latest refresh failed.' }}
        />
      </MemoryRouter>,
    );

    expect(screen.getByText(/Telemetry stale/).closest('div')).toHaveTextContent('Latest refresh failed');
    expect(screen.getAllByText('8').length).toBeGreaterThan(0);
    expect(screen.getAllByText('58').length).toBeGreaterThan(0);
  });

  it('does not present a stopped server\'s last sample as a live reading or a warning', () => {
    render(
      <MemoryRouter>
        <ServerCard
          server={{ id: 'server-7', name: 'Horror', status: 'stopped' }}
          metrics={{
            latest: { player_count: 3, fps: 120.1 },
            timeseries: [
              { timestamp: '2026-08-30T15:00:00.000Z', fps: 119, player_count: 2 },
              { timestamp: '2026-08-30T15:05:00.000Z', fps: 120.1, player_count: 3 },
            ],
          }}
          metricsState={{ status: 'stale', sampledAt: '2026-08-30T15:05:00.000Z' }}
        />
      </MemoryRouter>,
    );

    expect(screen.queryByText('120.1')).not.toBeInTheDocument();
    expect(screen.queryByText(/Telemetry stale/)).not.toBeInTheDocument();
    expect(screen.getByText(/Not reporting while offline/)).toBeInTheDocument();
  });

  it('disables all server controls and names the active action while it is pending', () => {
    render(
      <MemoryRouter>
        <ServerCard
          server={{ id: 'server-5', name: 'Operations', status: 'running' }}
          pendingAction="restart"
          onStop={vi.fn()}
          onRestart={vi.fn()}
        />
      </MemoryRouter>,
    );

    expect(screen.getByRole('button', { name: 'Stop Operations' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Restarting Operations' })).toBeDisabled();
    expect(screen.getByText('Restarting')).toBeInTheDocument();
  });
});

describe('ServerCard failure cause', () => {
  it('leads a crash-looping card with the diagnosed cause and a way to fix it', () => {
    render(
      <MemoryRouter>
        <ServerCard
          server={{
            id: 'fun-ops',
            name: 'Fun Ops',
            status: 'crash_loop',
            summary_message: 'Docker restarted the container 3 times in 15 min. The game exits during boot. Cause: The configured scenario is not available: Scenario X could not be read',
          }}
        />
      </MemoryRouter>,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('The configured scenario is not available');
    expect(screen.getByRole('alert')).not.toHaveTextContent('Docker restarted');
    expect(screen.getByRole('link', { name: /Diagnose and fix/ })).toHaveAttribute('href', '/servers/fun-ops/diagnosis');
  });

  it('picks the cause-bearing line from an older frequency-ranked summary', () => {
    const cause = failureCause({
      summary_message: "Docker restarted the container 3 times. Top engine errors: WORLD (E): Unknown class 'SCR_ChimeraCharacter' | RESOURCES (E): Failed to load | ENGINE (E): Unable to read the mission header '{X}Missions/A.conf'",
    });
    expect(cause).toBe("ENGINE (E): Unable to read the mission header '{X}Missions/A.conf'");
  });

  it('explains an errored server with its latest action error, not an old crash summary', () => {
    const server = {
      status: 'error',
      summary_message: 'Docker restarted the container 3 times. Top engine errors: ENGINE (E): Unable to initialize the game',
      last_docker_error: 'Docker client is not available',
    };
    expect(failureCause(server)).toBe('Docker client is not available');
    expect(currentFailureMessage(server)).toBe('Docker client is not available');
    // Outside a failed state the provisioning summary is still the better text.
    expect(currentFailureMessage({ ...server, status: 'running' })).toContain('Docker restarted');
  });
});

describe('parseServerDate', () => {
  it('reads offset-less API timestamps as UTC and leaves zoned ones alone', () => {
    expect(parseServerDate('2026-10-10T21:12:27.284000').toISOString()).toBe('2026-10-10T21:12:27.284Z');
    expect(parseServerDate('2026-10-10T21:12').toISOString()).toBe('2026-10-10T21:12:00.000Z');
    expect(parseServerDate('2026-10-10T21:12:27+00:00').toISOString()).toBe('2026-10-10T21:12:27.000Z');
    expect(parseServerDate('2026-10-10T17:12:27-04:00').toISOString()).toBe('2026-10-10T21:12:27.000Z');
    expect(parseServerDate('')).toBeNull();
    expect(parseServerDate('not a date')).toBeNull();
  });
});
