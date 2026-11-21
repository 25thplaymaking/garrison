// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import apiClient from '@/lib/apiClient';
import ServerSettingsModule, {
  mergeSubmittedConfigSecrets,
  ServerPasswordInput,
} from './ServerSettingsModule';

let outletContext;
vi.mock('react-router', () => ({
  useOutletContext: () => outletContext,
}));

vi.mock('@/lib/apiClient', () => ({
  default: { get: vi.fn(), post: vi.fn(), put: vi.fn() },
}));

vi.mock('@/context/UnsavedChangesContext', () => ({
  useUnsavedChanges: () => ({ registerDirtySource: vi.fn(() => () => {}) }),
}));


vi.mock('@/components/ScenarioSelector', () => ({
  default: () => <div data-testid="scenario-selector" />,
}));

vi.mock('@/components/ui/switch', () => ({
  Switch: ({ checked, onCheckedChange, ...props }) => (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onCheckedChange?.(!checked)}
      {...props}
    />
  ),
}));

const STORED_CONFIG = {
  game: {
    name: 'Public Testing GM',
    password: 'join-before',
    passwordAdmin: 'admin-before',
    gameProperties: { persistence: {} },
  },
  rcon: { password: 'rcon-before', permission: 'admin' },
  a2s: {},
  operating: {},
};

beforeEach(() => {
  vi.clearAllMocks();
  outletContext = {
    server: {
      id: 'srv-1',
      name: 'Example',
      config: {
        ...STORED_CONFIG,
        game: { ...STORED_CONFIG.game, password: '***', passwordAdmin: '***' },
        rcon: { ...STORED_CONFIG.rcon, password: '***' },
      },
      log_stats_enabled: true,
      max_fps: 120,
      startup_parameters: [],
    },
    serverId: 'srv-1',
    fetchServer: vi.fn(() => Promise.resolve()),
    user: { id: 'admin-1', username: 'Admin', role: 'admin' },
  };
  apiClient.get.mockImplementation((url) => {
    if (url === '/servers/srv-1/config') {
      return Promise.resolve({ data: { config: STORED_CONFIG, revision: 4 } });
    }
    if (url === '/servers/srv-1/config/history') {
      return Promise.resolve({ data: { items: [], total: 0 } });
    }
    return Promise.resolve({ data: {} });
  });
  apiClient.post.mockResolvedValue({ data: { message: 'Backup created' } });
});

afterEach(cleanup);

describe('server password inputs', () => {
  test('toggles a password between concealed and visible states', () => {
    const onChange = vi.fn();
    render(<ServerPasswordInput label="Admin Password" value="chosen-secret" onChange={onChange} />);

    const input = screen.getByLabelText('Admin Password');
    expect(input).toHaveAttribute('type', 'password');

    fireEvent.click(screen.getByRole('button', { name: 'Show Admin Password' }));
    expect(input).toHaveAttribute('type', 'text');
    expect(screen.getByRole('button', { name: 'Hide Admin Password' })).toHaveAttribute('aria-pressed', 'true');

    fireEvent.change(input, { target: { value: 'next-secret' } });
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  test('replaces response masks with all submitted secrets while retaining normalized fields', () => {
    const submitted = {
      game: { password: 'new-join', passwordAdmin: 'new-admin' },
      rcon: { password: 'new-rcon' },
    };
    const response = {
      game: { password: '***', passwordAdmin: '***', maxPlayers: 64 },
      rcon: { password: '***', permission: 'monitor' },
    };

    const merged = mergeSubmittedConfigSecrets(response, submitted);

    expect(merged.game).toMatchObject({ password: 'new-join', passwordAdmin: 'new-admin', maxPlayers: 64 });
    expect(merged.rcon).toMatchObject({ password: 'new-rcon', permission: 'monitor' });
    expect(response.game.passwordAdmin).toBe('***');
  });

  test('submits and keeps the exact chosen password after the masked save response', async () => {
    apiClient.put.mockResolvedValue({
      data: {
        config: {
          ...STORED_CONFIG,
          game: { ...STORED_CONFIG.game, password: '***', passwordAdmin: '***' },
          rcon: { ...STORED_CONFIG.rcon, password: '***' },
        },
      },
    });

    render(<ServerSettingsModule />);

    const adminPassword = await screen.findByLabelText('Admin Password');
    fireEvent.change(adminPassword, { target: { value: 'the-selected-password' } });
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => expect(apiClient.put).toHaveBeenCalledWith(
      '/servers/srv-1',
      expect.objectContaining({
        config: expect.objectContaining({
          game: expect.objectContaining({ passwordAdmin: 'the-selected-password' }),
        }),
        base_revision: 4,
      }),
      expect.objectContaining({ validateStatus: expect.any(Function) }),
    ));

    await waitFor(() => expect(adminPassword).toHaveValue('the-selected-password'));
    fireEvent.click(screen.getByRole('button', { name: 'Show Admin Password' }));
    expect(adminPassword).toHaveAttribute('type', 'text');
    expect(adminPassword).toHaveValue('the-selected-password');
  });
});

describe('settings saves and the mod list', () => {
  test('sends the deployed mods, not the ones loaded with the form', async () => {
    const loadedMods = [{ modId: 'AAAAAAAAAAAAAAAA', name: 'Old' }];
    const deployedMods = [{ modId: 'BBBBBBBBBBBBBBBB', name: 'Deployed since' }];
    let configReads = 0;
    apiClient.get.mockImplementation((url) => {
      if (url === '/servers/srv-1/config') {
        configReads += 1;
        const mods = configReads === 1 ? loadedMods : deployedMods;
        return Promise.resolve({ data: { config: { ...STORED_CONFIG, game: { ...STORED_CONFIG.game, mods } }, revision: 4 } });
      }
      if (url === '/servers/srv-1/config/history') {
        return Promise.resolve({ data: { items: [], total: 0 } });
      }
      return Promise.resolve({ data: {} });
    });
    apiClient.put.mockResolvedValue({ data: { config: STORED_CONFIG } });

    render(<ServerSettingsModule />);

    const adminPassword = await screen.findByLabelText('Admin Password');
    fireEvent.change(adminPassword, { target: { value: 'another-password' } });
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => expect(apiClient.put).toHaveBeenCalled());
    const payload = apiClient.put.mock.calls[0][1];
    expect(payload.config.game.mods).toEqual(deployedMods);
  });
});
