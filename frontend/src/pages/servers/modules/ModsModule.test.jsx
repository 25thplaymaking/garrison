// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import apiClient from '@/lib/apiClient';
import ModsModule from './ModsModule';

// ModsModule is a large, stateful workspace module (Workshop browser, load
// order editor, mirror, batch import/export) that reads its server context
// from useOutletContext and several app-wide providers. This test focuses
// narrowly on the new Mod Presets panel (list / create / delete) rather than
// re-verifying the pre-existing tabs, per the file's existing lack of test
// scaffolding.

const SERVER = {
  id: 'srv-1',
  name: 'Test Server',
  mods: [
    { mod_id: 'sat-mod', name: 'Server Admin Tools', enabled: true, system_managed: true },
    { mod_id: 'm1', name: 'Mod One', enabled: true, version: '1.0.0' },
  ],
};

let outletContext;
vi.mock('react-router', () => ({
  useOutletContext: () => outletContext,
}));

vi.mock('@/lib/apiClient', () => ({
  default: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));

vi.mock('@/context/UnsavedChangesContext', () => ({
  useUnsavedChanges: () => ({ registerDirtySource: vi.fn(() => () => {}) }),
}));


const confirmMock = vi.fn(() => Promise.resolve(true));
vi.mock('@/hooks/useConfirmDialog', () => ({
  default: () => ({ confirm: confirmMock, dialog: null }),
}));

const EXISTING_PRESET = { id: 'preset-1', name: 'Vanilla+', mods: [{ mod_id: 'm1', name: 'Mod One' }] };

function mockApi({ presets = [EXISTING_PRESET], workshopMods = [] } = {}) {
  apiClient.get.mockImplementation((url) => {
    if (url === '/servers/presets') return Promise.resolve({ data: presets });
    if (url === '/servers/mod-download-history') return Promise.resolve({ data: [] });
    if (url === '/servers/srv-1/scenarios') return Promise.resolve({ data: { shared: [] } });
    if (url === '/workshop/browse') return Promise.resolve({ data: { mods: workshopMods, total_pages: 1 } });
    if (url === '/workshop/search') return Promise.resolve({ data: { mods: [], total_pages: 1 } });
    if (url === '/servers/workshop/search') return Promise.resolve({ data: { mods: [], total: 0 } });
    return Promise.resolve({ data: {} });
  });
  apiClient.post.mockResolvedValue({ data: { id: 'preset-2', name: 'New Preset', mods: [] } });
  apiClient.delete.mockResolvedValue({ data: { message: 'Preset deleted', id: 'preset-1' } });
}

beforeEach(() => {
  vi.clearAllMocks();
  confirmMock.mockClear();
  confirmMock.mockImplementation(() => Promise.resolve(true));
  outletContext = {
    server: SERVER,
    serverId: 'srv-1',
    fetchServer: vi.fn(() => Promise.resolve()),
    canManage: true,
    user: { id: 'admin-1', username: 'Admin', role: 'admin' },
    bumpScenarioRefresh: vi.fn(),
  };
});

afterEach(() => {
  cleanup();
});

async function openPresetsTab() {
  render(<ModsModule />);
  // Radix Tabs switches on mousedown (or focus/keydown), not on click — see
  // @radix-ui/react-tabs's TabsTrigger implementation.
  fireEvent.mouseDown(screen.getByRole('tab', { name: /presets/i }));
  await waitFor(() => expect(apiClient.get).toHaveBeenCalledWith('/servers/presets'));
}

describe('Mod Presets panel', () => {
  test('lists existing presets with their mod count', async () => {
    mockApi();
    await openPresetsTab();

    expect(await screen.findByText('Vanilla+')).toBeInTheDocument();
    expect(screen.getByText('1 mod')).toBeInTheDocument();
  });

  test('shows an empty state when there are no presets', async () => {
    mockApi({ presets: [] });
    await openPresetsTab();

    expect(await screen.findByText('No mod presets yet')).toBeInTheDocument();
  });

  test('saves the currently loaded server mods as a new preset', async () => {
    mockApi();
    await openPresetsTab();
    await screen.findByText('Vanilla+');

    fireEvent.click(screen.getByRole('button', { name: /save current mods as preset/i }));
    fireEvent.change(screen.getByPlaceholderText('Preset name'), { target: { value: 'My New Preset' } });
    fireEvent.click(screen.getByRole('button', { name: /^save preset$/i }));

    await waitFor(() => expect(apiClient.post).toHaveBeenCalledWith('/servers/presets', expect.objectContaining({
      name: 'My New Preset',
      mods: expect.arrayContaining([
        expect.objectContaining({ mod_id: 'sat-mod' }),
        expect.objectContaining({ mod_id: 'm1' }),
      ]),
    })));
    // The saved dialog closes and the list refreshes after a successful save.
    await waitFor(() => expect(screen.queryByPlaceholderText('Preset name')).not.toBeInTheDocument());
  });

  test('deletes a preset after confirmation', async () => {
    mockApi();
    await openPresetsTab();
    await screen.findByText('Vanilla+');

    fireEvent.click(screen.getByRole('button', { name: /delete preset vanilla\+/i }));

    await waitFor(() => expect(confirmMock).toHaveBeenCalled());
    await waitFor(() => expect(apiClient.delete).toHaveBeenCalledWith('/servers/presets/preset-1'));
  });

  test('applies a saved preset to the current server after confirmation', async () => {
    mockApi();
    await openPresetsTab();
    await screen.findByText('Vanilla+');

    fireEvent.click(screen.getByRole('button', { name: /apply preset vanilla\+/i }));

    await waitFor(() => expect(confirmMock).toHaveBeenCalled());
    await waitFor(() => expect(apiClient.post).toHaveBeenCalledWith(
      '/servers/srv-1/mods/import-json',
      { mods: EXISTING_PRESET.mods },
      expect.objectContaining({ validateStatus: expect.any(Function) }),
    ));
    await waitFor(() => expect(outletContext.fetchServer).toHaveBeenCalledWith(true));
  });

  test('does not delete when the confirmation is declined', async () => {
    confirmMock.mockImplementation(() => Promise.resolve(false));
    mockApi();
    await openPresetsTab();
    await screen.findByText('Vanilla+');

    fireEvent.click(screen.getByRole('button', { name: /delete preset vanilla\+/i }));

    await waitFor(() => expect(confirmMock).toHaveBeenCalled());
    expect(apiClient.delete).not.toHaveBeenCalled();
  });

  test('disables mutating preset actions when the user cannot manage servers', async () => {
    mockApi();
    outletContext.canManage = false;
    await openPresetsTab();
    await screen.findByText('Vanilla+');

    expect(screen.getByRole('button', { name: /save current mods as preset/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /apply preset vanilla\+/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /delete preset vanilla\+/i })).toBeDisabled();
  });
});

describe('Workshop availability', () => {
  test('labels removed mods and prevents adding them to a new loadout', async () => {
    mockApi({
      workshopMods: [{
        mod_id: 'REMOVED-MOD',
        name: 'Retired Operation',
        removed_from_workshop: true,
        availability_status: 'removed',
      }],
    });
    render(<ModsModule />);

    expect(await screen.findByText('Removed from Workshop')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Removed from Workshop: Retired Operation' })).toBeDisabled();
  });
});

describe('Workshop add enrichment', () => {
  // Browse and search listings publish no dependency list, so a mod added
  // straight from the Workshop tab used to arrive with `dependencies: []`, the
  // dependency prompt never fired, and its dependencies were silently left out
  // of the loadout. The add path must look the mod's metadata up first.
  function mockBrowseResult(mod) {
    mockApi({ workshopMods: [mod] });
    apiClient.get.mockImplementation((url) => {
      if (url === `/servers/workshop/mod/${mod.mod_id}/details`) {
        return Promise.resolve({
          data: {
            mod_id: mod.mod_id,
            name: mod.name,
            version: '2.1.0',
            dependencies: [{ mod_id: 'DEP-1', name: 'Dependency One', version: '1.0.0' }],
          },
        });
      }
      if (url === '/servers/presets') return Promise.resolve({ data: [] });
      if (url === '/servers/mod-download-history') return Promise.resolve({ data: [] });
      if (url === '/servers/srv-1/scenarios') return Promise.resolve({ data: { shared: [] } });
      if (url === '/workshop/browse') return Promise.resolve({ data: { mods: [mod], total_pages: 1 } });
      if (url === '/servers/workshop/search') return Promise.resolve({ data: { mods: [], total: 0 } });
      return Promise.resolve({ data: {} });
    });
    apiClient.post.mockImplementation((url) => {
      if (url === '/servers/srv-1/mods/resolve-dependencies') {
        return Promise.resolve({
          data: {
            mod_id: mod.mod_id,
            resolved: [
              { mod_id: 'DEP-1', name: 'Dependency One', already_present: false, metadata_available: true },
              { mod_id: mod.mod_id, name: mod.name, already_present: false, metadata_available: true },
            ],
            new_count: 1,
            partial: false,
            unresolved_count: 0,
            stale_count: 0,
          },
        });
      }
      return Promise.resolve({ data: {} });
    });
  }

  test('resolves dependencies for a browse result that declares none', async () => {
    mockBrowseResult({ mod_id: 'NEW-MOD', name: 'Fresh Mod' });
    render(<ModsModule />);

    fireEvent.click(await screen.findByRole('button', { name: 'Add Fresh Mod to load order' }));

    await waitFor(() => expect(apiClient.get).toHaveBeenCalledWith('/servers/workshop/mod/NEW-MOD/details'));
    await waitFor(() => expect(apiClient.post).toHaveBeenCalledWith(
      '/servers/srv-1/mods/resolve-dependencies',
      expect.objectContaining({ mod_id: 'NEW-MOD' }),
    ));
    // The prompt the operator sees, rather than a silent add.
    expect(await screen.findByText(/Dependency Resolution/)).toBeInTheDocument();
  });

  test('does not call the resolve endpoint when the mod really has no dependencies', async () => {
    mockApi({ workshopMods: [{ mod_id: 'LONE-MOD', name: 'Standalone Mod' }] });
    apiClient.get.mockImplementation((url) => {
      if (url === '/servers/workshop/mod/LONE-MOD/details') {
        return Promise.resolve({ data: { mod_id: 'LONE-MOD', name: 'Standalone Mod', dependencies: [] } });
      }
      if (url === '/servers/presets') return Promise.resolve({ data: [] });
      if (url === '/servers/mod-download-history') return Promise.resolve({ data: [] });
      if (url === '/servers/srv-1/scenarios') return Promise.resolve({ data: { shared: [] } });
      if (url === '/workshop/browse') return Promise.resolve({ data: { mods: [{ mod_id: 'LONE-MOD', name: 'Standalone Mod' }], total_pages: 1 } });
      return Promise.resolve({ data: {} });
    });

    render(<ModsModule />);
    fireEvent.click(await screen.findByRole('button', { name: 'Add Standalone Mod to load order' }));

    await waitFor(() => expect(apiClient.get).toHaveBeenCalledWith('/servers/workshop/mod/LONE-MOD/details'));
    expect(apiClient.post).not.toHaveBeenCalledWith(
      '/servers/srv-1/mods/resolve-dependencies',
      expect.anything(),
    );
  });
});
