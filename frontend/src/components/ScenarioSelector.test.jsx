// @vitest-environment jsdom
//
// Loop-20 fix: adding/removing a server-only scenario previously swallowed a
// failed PUT /servers/{id}/scenarios with no toast, then unconditionally
// selected/cleared the scenario in the parent form anyway — the UI looked
// like the save worked even though nothing persisted. This pins that a
// failed save now toasts and does NOT call onChange/clear the input.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import apiClient from '@/lib/apiClient';
import { toast } from '@/hooks/use-toast';
import ScenarioSelector from './ScenarioSelector';

vi.mock('@/lib/apiClient', () => ({
  default: { get: vi.fn(), put: vi.fn() },
}));

vi.mock('@/hooks/use-toast', () => ({
  toast: vi.fn(),
}));

function mockScenarios() {
  apiClient.get.mockResolvedValue({
    data: { vanilla: [], shared: [], mod: [], custom: [] },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
});

describe('ScenarioSelector custom scenario save failure handling', () => {
  test('a failed save toasts an error and does not select the unsaved scenario', async () => {
    mockScenarios();
    apiClient.put.mockRejectedValue({ response: { data: { detail: 'Server unreachable' } } });
    const onChange = vi.fn();

    render(<ScenarioSelector value="" onChange={onChange} serverId="srv-1" />);
    await waitFor(() => expect(apiClient.get).toHaveBeenCalled());

    fireEvent.change(screen.getByPlaceholderText(/Add a server-only scenario ID/i), {
      target: { value: 'MyMission.conf' },
    });
    fireEvent.click(screen.getByRole('button', { name: /add/i }));

    await waitFor(() => expect(apiClient.put).toHaveBeenCalled());
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({
      variant: 'destructive',
      title: 'Failed to save scenario list',
    })));
    expect(onChange).not.toHaveBeenCalled();
  });

  test('a successful save selects the new scenario and clears the input', async () => {
    mockScenarios();
    apiClient.put.mockResolvedValue({ data: {} });
    const onChange = vi.fn();

    render(<ScenarioSelector value="" onChange={onChange} serverId="srv-1" />);
    await waitFor(() => expect(apiClient.get).toHaveBeenCalled());

    fireEvent.change(screen.getByPlaceholderText(/Add a server-only scenario ID/i), {
      target: { value: 'MyMission.conf' },
    });
    fireEvent.click(screen.getByRole('button', { name: /add/i }));

    await waitFor(() => expect(apiClient.put).toHaveBeenCalled());
    await waitFor(() => expect(onChange).toHaveBeenCalledWith('MyMission.conf'));
    expect(toast).not.toHaveBeenCalled();
  });
});
