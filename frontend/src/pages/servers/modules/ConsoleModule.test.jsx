// @vitest-environment jsdom

import React from 'react';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import ConsoleModule, { getLineClass, normalizeEntry, sourceTone } from './ConsoleModule';

class FakeWebSocket {
  static instances = [];

  constructor(url) {
    this.url = url;
    FakeWebSocket.instances.push(this);
    this.sent = [];
    setTimeout(() => {
      this.onopen?.();
    }, 0);
  }

  send(data) {
    this.sent.push(data);
  }

  close(code = 1000, reason = '') {
    this.onclose?.({ code, reason });
  }

  emitMessage(payload) {
    const data = typeof payload === 'string' ? payload : JSON.stringify(payload);
    this.onmessage?.({ data });
  }
}

const outletContext = {
  server: { id: 'srv-1', name: 'Arma Test Server', status: 'running' },
  serverId: 'srv-1',
};

vi.mock('react-router', async () => {
  const actual = await vi.importActual('react-router');
  return {
    ...actual,
    useOutletContext: () => outletContext,
  };
});

describe('ConsoleModule optimizations and functionality', () => {
  let originalWebSocket;

  beforeEach(() => {
    vi.useFakeTimers();
    FakeWebSocket.instances = [];
    originalWebSocket = globalThis.WebSocket;
    globalThis.WebSocket = FakeWebSocket;
  });

  afterEach(() => {
    cleanup();
    vi.clearAllTimers();
    vi.useRealTimers();
    globalThis.WebSocket = originalWebSocket;
  });

  describe('normalizeEntry precomputations', () => {
    it('precomputes formatted timestamp, tone, and line classification', () => {
      const raw = {
        cursor: 'c1',
        seq: 10,
        line: 'Fatal: server memory crash',
        timestamp: '2026-09-11T14:30:15.000Z',
        source: 'engine',
        path: 'console.log',
      };

      const entry = normalizeEntry(raw, 'fallback');
      expect(entry.id).toBe('c1');
      expect(entry.seq).toBe(10);
      expect(entry.text).toBe('Fatal: server memory crash');
      expect(entry.formattedTs).toMatch(/^\d{2}:\d{2}:\d{2}$/);
      expect(entry.lineClass).toBe('text-red-400');
      expect(entry.sourceLabel).toBe('engine');
      expect(entry.sourceTone).toContain('text-purple-300');
      expect(entry.searchCorpus).toContain('fatal: server memory crash');
    });

    it('classifies warnings, restarts, and standard lines correctly', () => {
      expect(getLineClass('Warning: high packet loss')).toBe('text-amber-300');
      expect(getLineClass('Server restart in 30s')).toBe('text-blue-400 font-semibold');
      expect(getLineClass('Connected player Kestrel')).toBe('text-mil-muted');
    });

    it('determines source tones for all stream types', () => {
      expect(sourceTone('docker')).toContain('text-zinc-300');
      expect(sourceTone('console')).toContain('text-blue-300');
      expect(sourceTone('profile')).toContain('text-blue-300');
      expect(sourceTone('engine')).toContain('text-purple-300');
      expect(sourceTone('backend')).toContain('text-purple-300');
      expect(sourceTone('rcon')).toContain('text-amber-300');
    });
  });

  describe('WebSocket stream and virtualization', () => {
    it('connects to websocket and displays status transition to live', async () => {
      render(<ConsoleModule />);

      // Initially connecting
      expect(screen.getByText(/Connecting to live stream/i)).toBeInTheDocument();

      const ws = FakeWebSocket.instances[0];
      expect(ws).toBeDefined();

      // Emit status backfilling then live
      act(() => {
        ws.emitMessage({ type: 'status', state: 'backfilling', count: 2 });
      });
      expect(screen.getByText(/Loading 2 recent lines.../i)).toBeInTheDocument();

      act(() => {
        ws.emitMessage({
          type: 'status',
          state: 'live',
          sources: { docker: { available: true } },
        });
      });
      expect(screen.getByText(/Live stream connected/i)).toBeInTheDocument();
    });

    it('batches rapid logs and renders only the virtualized visible window', async () => {
      render(<ConsoleModule />);
      const ws = FakeWebSocket.instances[0];

      // Mark live
      act(() => {
        ws.emitMessage({ type: 'status', state: 'live' });
      });

      // Stream 200 log lines rapidly
      act(() => {
        for (let i = 0; i < 200; i++) {
          ws.emitMessage({
            type: 'log',
            cursor: `cur-${i}`,
            seq: i + 1,
            timestamp: '2026-09-11T12:00:00.000Z',
            line: `Mission log entry #${i} - operational check`,
            source: 'docker',
          });
        }
      });

      // Advance timers to trigger the throttled batch flush (64ms)
      act(() => {
        vi.advanceTimersByTime(100);
      });

      // Verify total entries indicator
      expect(screen.getByText(/200 entries in view/i)).toBeInTheDocument();

      // In the virtualized viewport, NOT all 200 elements are rendered as DOM rows.
      // Only the visible slice plus overscan is rendered (~40-60 rows).
      const renderedRows = screen.getAllByTestId('console-log-row');
      expect(renderedRows.length).toBeLessThan(100);
      expect(renderedRows.length).toBeGreaterThan(0);
    });

    it('caps log buffer at MAX_LOG_BUFFER (2000) under heavy load', async () => {
      render(<ConsoleModule />);
      const ws = FakeWebSocket.instances[0];

      act(() => {
        ws.emitMessage({ type: 'status', state: 'live' });
      });

      // Stream 2,500 lines
      act(() => {
        for (let i = 0; i < 2500; i++) {
          ws.emitMessage({
            type: 'log',
            cursor: `flood-${i}`,
            seq: i + 1,
            timestamp: '2026-09-11T12:00:00.000Z',
            line: `Flood line #${i}`,
            source: 'docker',
          });
        }
      });

      act(() => {
        vi.advanceTimersByTime(200);
      });

      // Total entries should be capped at 2000
      expect(screen.getByText(/2000 entries in view/i)).toBeInTheDocument();
    });

    it('allows pausing and resuming auto-scroll', async () => {
      render(<ConsoleModule />);
      const pauseButton = screen.getByRole('button', { name: /pause/i });

      // Click pause
      fireEvent.click(pauseButton);
      expect(screen.getByRole('button', { name: /resume/i })).toBeInTheDocument();
      expect(screen.getByText(/auto-scroll paused/i)).toBeInTheDocument();

      // Click resume
      const resumeButton = screen.getByRole('button', { name: /resume/i });
      fireEvent.click(resumeButton);
      expect(screen.getByRole('button', { name: /pause/i })).toBeInTheDocument();
    });

    it('filters log lines using the precomputed search corpus', async () => {
      render(<ConsoleModule />);
      const ws = FakeWebSocket.instances[0];

      act(() => {
        ws.emitMessage({ type: 'status', state: 'live' });
        ws.emitMessage({
          type: 'log',
          cursor: 'line-1',
          seq: 1,
          line: 'Alpha patrol deployed',
          source: 'docker',
        });
        ws.emitMessage({
          type: 'log',
          cursor: 'line-2',
          seq: 2,
          line: 'Bravo vehicle refueled',
          source: 'docker',
        });
      });

      act(() => {
        vi.advanceTimersByTime(100);
      });

      expect(screen.getByText(/2 entries in view/i)).toBeInTheDocument();

      // Type filter
      const filterInput = screen.getByPlaceholderText(/filter console lines/i);
      fireEvent.change(filterInput, { target: { value: 'bravo' } });

      expect(screen.getByText(/1 entries in view/i)).toBeInTheDocument();
      expect(screen.queryByText(/Alpha patrol deployed/i)).not.toBeInTheDocument();
      expect(screen.getByText(/Bravo vehicle refueled/i)).toBeInTheDocument();
    });

    it('clears logs when Clear button is clicked', async () => {
      render(<ConsoleModule />);
      const ws = FakeWebSocket.instances[0];

      act(() => {
        ws.emitMessage({ type: 'status', state: 'live' });
        ws.emitMessage({
          type: 'log',
          cursor: 'line-1',
          seq: 1,
          line: 'Clear me please',
          source: 'docker',
        });
      });

      act(() => {
        vi.advanceTimersByTime(100);
      });

      expect(screen.getByText(/Clear me please/i)).toBeInTheDocument();

      const clearButton = screen.getByRole('button', { name: /clear/i });
      fireEvent.click(clearButton);

      expect(screen.queryByText(/Clear me please/i)).not.toBeInTheDocument();
      expect(screen.getByText(/No merged logs available yet/i)).toBeInTheDocument();
    });

    it('copies filtered logs to clipboard when Copy is clicked', async () => {
      const writeText = vi.fn().mockResolvedValue(undefined);
      Object.assign(navigator, {
        clipboard: { writeText },
      });

      render(<ConsoleModule />);
      const ws = FakeWebSocket.instances[0];

      act(() => {
        ws.emitMessage({ type: 'status', state: 'live' });
        ws.emitMessage({
          type: 'log',
          cursor: 'copy-1',
          seq: 1,
          timestamp: '2026-09-11T10:00:00Z',
          line: 'Copy test message',
          source: 'docker',
        });
      });

      act(() => {
        vi.advanceTimersByTime(100);
      });

      const copyButton = screen.getByRole('button', { name: /copy/i });
      await act(async () => {
        fireEvent.click(copyButton);
      });

      expect(writeText).toHaveBeenCalledWith('[2026-09-11T10:00:00Z] [docker] Copy test message');
    });
  });
});
