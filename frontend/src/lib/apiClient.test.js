// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import apiClient, { UNAUTHORIZED_EVENT } from './apiClient';
import { API } from '@/utils/api';

describe('apiClient', () => {
  it('targets the shared API base URL', () => {
    expect(apiClient.defaults.baseURL).toBe(API);
  });

  it('sends credentials by default for cookie-session auth', () => {
    expect(apiClient.defaults.withCredentials).toBe(true);
  });

  it('has a finite default timeout', () => {
    expect(apiClient.defaults.timeout).toBeGreaterThan(0);
  });
});

describe('apiClient 401 handling', () => {
  let dispatchSpy;

  beforeEach(() => {
    dispatchSpy = vi.spyOn(window, 'dispatchEvent');
  });

  afterEach(() => {
    dispatchSpy.mockRestore();
  });

  it('dispatches an UNAUTHORIZED_EVENT when a response carries status 401', async () => {
    const adapter = vi.fn().mockRejectedValue({
      isAxiosError: true,
      response: { status: 401, data: {}, headers: {}, config: {} },
      config: {},
    });
    const originalAdapter = apiClient.defaults.adapter;
    apiClient.defaults.adapter = adapter;
    try {
      await expect(apiClient.get('/whatever')).rejects.toBeDefined();
    } finally {
      apiClient.defaults.adapter = originalAdapter;
    }
    const dispatchedTypes = dispatchSpy.mock.calls.map(([evt]) => evt?.type);
    expect(dispatchedTypes).toContain(UNAUTHORIZED_EVENT);
  });

  it('does NOT dispatch UNAUTHORIZED for non-401 errors', async () => {
    const adapter = vi.fn().mockRejectedValue({
      isAxiosError: true,
      response: { status: 500, data: {}, headers: {}, config: {} },
      config: {},
    });
    const originalAdapter = apiClient.defaults.adapter;
    apiClient.defaults.adapter = adapter;
    try {
      await expect(apiClient.get('/whatever')).rejects.toBeDefined();
    } finally {
      apiClient.defaults.adapter = originalAdapter;
    }
    const dispatchedTypes = dispatchSpy.mock.calls.map(([evt]) => evt?.type);
    expect(dispatchedTypes).not.toContain(UNAUTHORIZED_EVENT);
  });
});
