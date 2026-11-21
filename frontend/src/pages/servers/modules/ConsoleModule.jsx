import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { useOutletContext } from 'react-router';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import {
  AlertTriangle,
  Copy,
  Download,
  Loader2,
  Pause,
  Play,
  Search,
  Terminal,
  Trash2,
} from 'lucide-react';
import { buildServerWsUrl } from '@/utils/serverRealtime';
import { normalizeServer } from '@/utils/serverStatus';

function formatTime(value) {
  if (!value) return '';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return String(value);
  const h = String(parsed.getHours()).padStart(2, '0');
  const m = String(parsed.getMinutes()).padStart(2, '0');
  const s = String(parsed.getSeconds()).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

export function getLineLevel(text) {
  const line = String(text || '');
  const lower = line.toLowerCase();
  // Word matches plus the Reforger engine's severity markers (`(E)`/`(W)`),
  // e.g. "SCRIPT (E): ..." and "BACKEND (E): ...", which carry errors that
  // don't contain the literal word "error".
  if (lower.includes('error') || lower.includes('fatal') || lower.includes('crash') || /\(E\)/.test(line)) return 'error';
  if (lower.includes('warn') || /\(W\)/.test(line)) return 'warn';
  return 'info';
}

export function getLineClass(text) {
  const level = getLineLevel(text);
  if (level === 'error') return 'text-red-400';
  if (level === 'warn') return 'text-amber-300';
  const lower = String(text || '').toLowerCase();
  if (lower.includes('restart') || lower.includes('shutdown')) return 'text-blue-400 font-semibold';
  return 'text-mil-muted';
}

export function sourceTone(source) {
  const base = String(source || 'docker').split(':')[0];
  if (base === 'docker') return 'border-zinc-700 text-zinc-300';
  if (base === 'console' || base === 'profile') return 'border-blue-600/30 text-blue-300';
  if (base === 'engine' || base === 'backend') return 'border-purple-600/30 text-purple-300';
  if (base === 'rcon') return 'border-amber-600/30 text-amber-300';
  return 'border-zinc-700 text-zinc-300';
}

export function normalizeEntry(entry, fallbackId) {
  const text = entry.line || entry.raw || '';
  const ts = entry.timestamp || new Date().toISOString();
  const source = entry.source || entry.stream || 'docker';
  const path = entry.path || '';
  return {
    id: entry.cursor || fallbackId,
    cursor: entry.cursor || String(fallbackId),
    seq: entry.seq || 0,
    text,
    ts,
    formattedTs: formatTime(ts),
    source,
    sourceLabel: String(source).replace(/_/g, ' '),
    sourceTone: sourceTone(source),
    lineClass: getLineClass(text),
    level: getLineLevel(text),
    path,
    searchCorpus: `${source} ${path} ${text}`.toLowerCase(),
  };
}

function formatConsoleLine(log) {
  return `[${log.ts}] [${log.source}] ${log.text}`;
}

const LIVE_LOG_STATUSES = new Set(['running', 'starting', 'initializing', 'stopping', 'crash_loop']);

const MAX_LOG_BUFFER = 2000;
const SCROLL_THRESHOLD = 60;
const MAX_CURSOR_CACHE = 5000;
const TRIMMED_CURSOR_CACHE = 3000;
const FLUSH_INTERVAL_MS = 64; // ~15 FPS max state updates during high log bursts
const ITEM_HEIGHT = 28;
const OVERSCAN = 25;

const SOURCE_LABELS = { docker: 'Docker', profile: 'Files', rcon: 'RCON' };

function SourceIndicators({ sourceStatus }) {
  if (!sourceStatus || Object.keys(sourceStatus).length === 0) return null;

  const allUnavailable = Object.values(sourceStatus).every((s) => !s.available);

  return (
    <span className="ml-2 inline-flex items-center gap-1.5 text-[11px]">
      {allUnavailable && (
        <AlertTriangle className="h-3 w-3 text-red-400" />
      )}
      {Object.entries(sourceStatus).map(([name, info]) => (
        <span
          key={name}
          className={info.available ? 'text-zinc-500' : 'text-red-400/70'}
          title={
            info.available
              ? `${SOURCE_LABELS[name] || name}: connected`
              : `${SOURCE_LABELS[name] || name}: ${info.reason || 'unavailable'}`
          }
        >
          {SOURCE_LABELS[name] || name}: {info.available ? '✓' : '✗'}
        </span>
      ))}
    </span>
  );
}

function ConsoleModule() {
  const { server: rawServer, serverId } = useOutletContext();
  const server = normalizeServer(rawServer);
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [paused, setPaused] = useState(false);
  const [isNearBottom, setIsNearBottom] = useState(true);
  const [filter, setFilter] = useState('');
  const [errorsOnly, setErrorsOnly] = useState(false);
  const [connectionState, setConnectionState] = useState('idle');
  const [backfillInfo, setBackfillInfo] = useState(null);
  const [sourceStatus, setSourceStatus] = useState(null);
  const [closeReason, setCloseReason] = useState('');
  const [reconnectWarning, setReconnectWarning] = useState('');

  // Virtualization state
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(500);

  const logRef = useRef(null);
  const wsRef = useRef(null);
  const reconnectTimerRef = useRef(null);
  const reconnectAttemptRef = useRef(0);
  const seenCursorsRef = useRef(new Set());
  const lastSeqRef = useRef(0);
  const pendingEntriesRef = useRef([]);
  const lastFlushTimeRef = useRef(0);
  const flushTimerRef = useRef(null);
  const pausedRef = useRef(paused);
  const isProgrammaticScrollRef = useRef(false);

  useEffect(() => {
    pausedRef.current = paused;
  }, [paused]);

  // Keep viewportHeight updated with element clientHeight
  useEffect(() => {
    const el = logRef.current;
    if (!el) return undefined;
    setViewportHeight(el.clientHeight || 500);
    if (typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        if (entry.contentRect?.height) {
          setViewportHeight(entry.contentRect.height);
        }
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const handleScroll = useCallback(() => {
    const el = logRef.current;
    if (!el) return;

    setScrollTop(el.scrollTop);

    // If scroll was initiated programmatically by auto-scroll, don't trigger pause
    if (isProgrammaticScrollRef.current) {
      isProgrammaticScrollRef.current = false;
      return;
    }

    const atBottom = (el.scrollHeight - el.scrollTop - el.clientHeight) < SCROLL_THRESHOLD;
    setIsNearBottom(atBottom);
    // Auto-pause when user scrolls away from the bottom
    if (!atBottom && !pausedRef.current) {
      setPaused(true);
    }
    if (atBottom && pausedRef.current) {
      setPaused(false);
    }
  }, []);

  const flushBatch = useCallback(() => {
    flushTimerRef.current = null;
    lastFlushTimeRef.current = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const batch = pendingEntriesRef.current;
    if (batch.length === 0) return;
    pendingEntriesRef.current = [];
    setLogs((prev) => {
      const merged = [...prev, ...batch];
      return merged.length > MAX_LOG_BUFFER ? merged.slice(-MAX_LOG_BUFFER) : merged;
    });
  }, []);

  const scheduleFlush = useCallback(() => {
    if (flushTimerRef.current) return;
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const elapsed = now - lastFlushTimeRef.current;
    if (elapsed >= FLUSH_INTERVAL_MS) {
      flushBatch();
    } else {
      flushTimerRef.current = setTimeout(flushBatch, FLUSH_INTERVAL_MS - elapsed);
    }
  }, [flushBatch]);

  // Cleanup on unmount
  useEffect(() => () => {
    if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
    if (wsRef.current) wsRef.current.close();
    if (flushTimerRef.current) clearTimeout(flushTimerRef.current);
  }, []);

  // WebSocket connection — this is now the ONLY data path (no REST initial fetch)
  useEffect(() => {
    // The log socket serves any server with a container (it refuses only
    // stopped/error/unknown). Booting and crash-looping servers are exactly
    // when the console matters; they used to show "Server offline".
    if (!LIVE_LOG_STATUSES.has(server?.status)) {
      setConnectionState('offline');
      setLoading(false);
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      if (wsRef.current) wsRef.current.close();
      return undefined;
    }

    let disposed = false;

    const connect = () => {
      if (disposed) return;
      const isReconnect = reconnectAttemptRef.current > 0;

      // Build URL with sequence-based reconnect
      const params = {};
      if (isReconnect && lastSeqRef.current > 0) {
        // Reconnect: use sequence number for precise backfill
        params.since_seq = lastSeqRef.current;
        params.tail = 0;
      } else {
        // First connect: request full initial history
        params.tail = 500;
      }

      const url = buildServerWsUrl(`/api/ws/servers/${serverId}/logs`, params);
      setConnectionState(isReconnect ? 'reconnecting' : 'connecting');
      setLoading(!isReconnect);

      // Reset state for first connect
      if (!isReconnect) {
        setLogs([]);
        seenCursorsRef.current = new Set();
        lastSeqRef.current = 0;
        pendingEntriesRef.current = [];
        setBackfillInfo(null);
        setReconnectWarning('');
        setScrollTop(0);
      }

      try {
        const ws = new WebSocket(url);
        wsRef.current = ws;

        ws.onopen = () => {
          reconnectAttemptRef.current = 0;
          // Don't set 'live' yet — wait for backend status message
        };

        ws.onmessage = (event) => {
          let payload;
          try {
            payload = JSON.parse(event.data);
          } catch {
            payload = { type: 'log', line: event.data };
          }

          // Handle status messages from backend
          if (payload.type === 'status') {
            if (payload.state === 'connected') {
              setConnectionState('connecting');
            } else if (payload.state === 'backfilling') {
              setConnectionState('backfilling');
              setBackfillInfo({ count: payload.count || 0 });
              if (payload.reconnect_gap) {
                setReconnectWarning('Some older lines were not retained during reconnect; showing the latest available history.');
              } else {
                setReconnectWarning('');
              }
            } else if (payload.state === 'live') {
              setConnectionState('live');
              setLoading(false);
              setBackfillInfo(null);
              setCloseReason('');
              if (payload.reconnect_gap) {
                setReconnectWarning('Reconnect resumed from the latest retained logs after a sequence gap.');
              } else {
                setReconnectWarning('');
              }
              if (payload.sources) {
                setSourceStatus(payload.sources);
              }
            }
            return;
          }

          // Handle heartbeat
          if (payload.type === 'heartbeat') {
            // Connection is alive — no action needed
            return;
          }

          // Handle errors from backend
          if (payload.type === 'error') {
            console.error('[Console] Stream error:', payload.code, payload.message);
            setConnectionState('stream_failed');
            return;
          }

          if (payload.type !== 'log') return;

          const entry = normalizeEntry(payload, `${Date.now()}-${Math.random()}`);

          // Dedup by cursor
          if (entry.cursor && seenCursorsRef.current.has(entry.cursor)) return;
          if (entry.cursor) {
            seenCursorsRef.current.add(entry.cursor);
            if (seenCursorsRef.current.size > MAX_CURSOR_CACHE) {
              const arr = [...seenCursorsRef.current];
              seenCursorsRef.current = new Set(arr.slice(-TRIMMED_CURSOR_CACHE));
            }
          }

          // Track sequence number for reconnect
          if (entry.seq > lastSeqRef.current) {
            lastSeqRef.current = entry.seq;
          }

          pendingEntriesRef.current.push(entry);
          if (pendingEntriesRef.current.length > MAX_LOG_BUFFER) {
            pendingEntriesRef.current = pendingEntriesRef.current.slice(-MAX_LOG_BUFFER);
          }
          scheduleFlush();
        };

        ws.onclose = (event) => {
          if (disposed) return;

          // Non-retriable close codes — stop reconnecting
          switch (event.code) {
            case 4001:
              setConnectionState('auth_failed');
              setLoading(false);
              return;
            case 4003:
              setConnectionState('no_permission');
              setLoading(false);
              return;
            case 4004:
              setConnectionState('server_not_found');
              setLoading(false);
              return;
            case 4006:
              setConnectionState('server_not_running');
              setLoading(false);
              return;
            default:
              break;
          }

          // Don't reconnect if server is no longer running
          if (server?.status !== 'running') {
            setConnectionState('offline');
            setLoading(false);
            return;
          }

          // Retriable — reconnect with exponential backoff
          reconnectAttemptRef.current += 1;
          const attempt = reconnectAttemptRef.current;
          // 1s, 2s, 4s, 8s, 10s cap
          const nextDelay = Math.min(10_000, 1000 * 2 ** Math.min(attempt - 1, 3));
          setConnectionState('reconnecting');
          setCloseReason(
            event.reason
              ? `Close ${event.code}: ${event.reason}`
              : `Close code ${event.code || 'unknown'}`,
          );
          reconnectTimerRef.current = setTimeout(connect, nextDelay);
        };

        ws.onerror = () => {
          // onerror always fires before onclose; let onclose handle state
        };
      } catch {
        reconnectAttemptRef.current += 1;
        const nextDelay = Math.min(10_000, 1000 * 2 ** Math.min(reconnectAttemptRef.current, 3));
        setConnectionState('reconnecting');
        reconnectTimerRef.current = setTimeout(connect, nextDelay);
      }
    };

    connect();

    return () => {
      disposed = true;
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      if (wsRef.current) wsRef.current.close();
    };
  }, [server?.status, serverId, scheduleFlush]);

  // Auto-scroll — always pin to bottom while not paused so that
  // new entries don't make the view look "scrolled up".
  useEffect(() => {
    if (paused) return;
    const el = logRef.current;
    if (!el) return;
    isProgrammaticScrollRef.current = true;
    requestAnimationFrame(() => {
      if (logRef.current) {
        logRef.current.scrollTop = logRef.current.scrollHeight;
        setScrollTop(logRef.current.scrollTop);
        setIsNearBottom(true);
      }
    });
  }, [logs, paused]);

  const filteredLogs = useMemo(() => {
    let result = logs;
    if (errorsOnly) {
      result = result.filter((log) => log.level === 'error');
    }
    if (filter) {
      const lowerFilter = filter.toLowerCase();
      result = result.filter((log) => log.searchCorpus.includes(lowerFilter));
    }
    return result;
  }, [filter, errorsOnly, logs]);

  // Virtualization window calculations
  const totalCount = filteredLogs.length;
  const totalHeight = totalCount * ITEM_HEIGHT;
  const startIndex = Math.max(0, Math.floor(scrollTop / ITEM_HEIGHT) - OVERSCAN);
  const visibleCount = Math.ceil(viewportHeight / ITEM_HEIGHT) + OVERSCAN * 2;
  const endIndex = Math.min(totalCount, startIndex + visibleCount);

  const topSpacerHeight = startIndex * ITEM_HEIGHT;
  const bottomSpacerHeight = Math.max(0, (totalCount - endIndex) * ITEM_HEIGHT);
  const visibleLogs = useMemo(
    () => filteredLogs.slice(startIndex, endIndex),
    [filteredLogs, startIndex, endIndex],
  );

  const handleCopy = async () => {
    const text = filteredLogs.map((log) => formatConsoleLine(log)).join('\n');
    await navigator.clipboard?.writeText(text);
  };

  const handleDownload = () => {
    const text = filteredLogs.map((log) => formatConsoleLine(log)).join('\n');
    const blob = new Blob([text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${server?.name || 'server'}-logs-${new Date().toISOString().slice(0, 10)}.txt`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const handleClear = useCallback(() => {
    setLogs([]);
    pendingEntriesRef.current = [];
    seenCursorsRef.current = new Set();
    setScrollTop(0);
  }, []);

  const connectionLabel = {
    idle: 'Waiting to connect',
    offline: 'Server offline',
    connecting: 'Connecting to live stream',
    backfilling: backfillInfo
      ? `Loading ${backfillInfo.count} recent lines...`
      : 'Loading recent history...',
    live: 'Live stream connected',
    reconnecting: 'Reconnecting to live stream',
    stream_failed: 'Stream source failed — check server status',
    auth_failed: 'Authentication failed — please refresh and log in',
    no_permission: 'Insufficient permissions for live console',
    server_not_found: 'Server not found',
    server_not_running: 'Server is not running',
  }[connectionState] || 'Waiting to connect';

  const dotColor = {
    offline: 'bg-zinc-600',
    connecting: 'bg-amber-400',
    backfilling: 'bg-blue-400',
    live: 'bg-brand',
    reconnecting: 'bg-amber-300',
    stream_failed: 'bg-red-500',
    auth_failed: 'bg-red-500',
    no_permission: 'bg-red-500',
    server_not_found: 'bg-red-500',
    server_not_running: 'bg-zinc-600',
  }[connectionState] || 'bg-zinc-600';

  const textColor = {
    offline: 'text-zinc-500',
    connecting: 'text-amber-300',
    backfilling: 'text-blue-300',
    live: 'text-brand',
    reconnecting: 'text-amber-300',
    stream_failed: 'text-red-400',
    auth_failed: 'text-red-400',
    no_permission: 'text-red-400',
    server_not_found: 'text-red-400',
    server_not_running: 'text-zinc-500',
  }[connectionState] || 'text-zinc-500';

  const handleTogglePause = useCallback(() => {
    setPaused((current) => {
      const next = !current;
      if (!next && logRef.current) {
        setIsNearBottom(true);
        isProgrammaticScrollRef.current = true;
        requestAnimationFrame(() => {
          if (logRef.current) {
            logRef.current.scrollTop = logRef.current.scrollHeight;
            setScrollTop(logRef.current.scrollTop);
          }
        });
      }
      return next;
    });
  }, []);

  return (
    <div className="flex h-full flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[220px] flex-1">
          <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-mil-dim" />
          <Input
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="Filter console lines"
            className="h-8 border-[rgba(232,131,58,0.15)] bg-mil-bg-deep pl-9 text-xs text-mil-fg placeholder:text-mil-dim rounded-none"
            style={{ fontFamily: "var(--font-mono)" }}
          />
        </div>
        <button
          onClick={handleTogglePause}
          className={`h-8 px-3 border text-xs transition-colors ${paused ? 'border-[rgba(244,162,97,0.3)] text-brand-light bg-[rgba(232,131,58,0.05)]' : 'border-[rgba(232,131,58,0.15)] text-mil-muted bg-mil-bg-deep hover:text-mil-fg'}`}
          style={{ fontFamily: "var(--font-mono)" }}
        >
          {paused ? <Play className="mr-1 h-3.5 w-3.5 inline-block" /> : <Pause className="mr-1 h-3.5 w-3.5 inline-block" />}
          {paused ? 'Resume' : 'Pause'}
        </button>
        <button
          onClick={() => setErrorsOnly((current) => !current)}
          className={`h-8 px-3 border text-xs transition-colors ${errorsOnly ? 'border-red-500/50 text-red-300 bg-red-500/10' : 'border-[rgba(232,131,58,0.15)] text-mil-muted bg-mil-bg-deep hover:text-mil-fg'}`}
          style={{ fontFamily: "var(--font-mono)" }}
        >
          <AlertTriangle className="mr-1 h-3.5 w-3.5 inline-block" /> Errors only
        </button>
        <button onClick={handleCopy} className="h-8 px-3 border border-[rgba(232,131,58,0.15)] bg-mil-bg-deep text-xs text-mil-muted hover:text-mil-fg transition-colors" style={{ fontFamily: "var(--font-mono)" }}>
          <Copy className="mr-1 h-3.5 w-3.5 inline-block" /> Copy
        </button>
        <button onClick={handleDownload} className="h-8 px-3 border border-[rgba(232,131,58,0.15)] bg-mil-bg-deep text-xs text-mil-muted hover:text-mil-fg transition-colors" style={{ fontFamily: "var(--font-mono)" }}>
          <Download className="mr-1 h-3.5 w-3.5 inline-block" /> Download
        </button>
        <button onClick={handleClear} className="h-8 px-3 border border-[rgba(232,131,58,0.15)] bg-mil-bg-deep text-xs text-mil-muted hover:text-mil-fg transition-colors" style={{ fontFamily: "var(--font-mono)" }}>
          <Trash2 className="mr-1 h-3.5 w-3.5 inline-block" /> Clear
        </button>
      </div>

      <div className="flex items-center gap-2 text-xs">
        <span className={`h-2 w-2 rounded-full ${dotColor} ${connectionState === 'live' ? 'animate-pulse' : ''} ${connectionState === 'backfilling' ? 'animate-pulse' : ''}`} />
        <span className={textColor}>
          {connectionLabel}
          {connectionState === 'reconnecting' && closeReason && (
            <span className="ml-1 text-zinc-600">({closeReason})</span>
          )}
        </span>
        {!!reconnectWarning && (
          <Badge variant="outline" className="ml-2 border-amber-500/40 text-[11px] text-amber-300">
            <AlertTriangle className="mr-1 h-3 w-3" />
            {reconnectWarning}
          </Badge>
        )}
        {(connectionState === 'live' || connectionState === 'reconnecting') && sourceStatus && (
          <SourceIndicators sourceStatus={sourceStatus} />
        )}
        {paused && (
          <Badge variant="outline" className="ml-2 border-amber-500/30 text-[11px] text-amber-300">
            {isNearBottom ? 'AUTO-SCROLL PAUSED' : 'SCROLLED UP · AUTO-SCROLL PAUSED'}
          </Badge>
        )}
        <span className="ml-auto text-mil-dim">{filteredLogs.length} entries in view</span>
      </div>

      <div className="flex-1 border border-[rgba(232,131,58,0.12)] bg-mil-bg-deep shadow-xl">
        <div
          ref={logRef}
          onScroll={handleScroll}
          className="h-[60vh] overflow-y-auto font-mono text-xs leading-relaxed"
          style={{ scrollBehavior: 'auto' }}
          data-testid="console-log-container"
        >
          {loading ? (
            <div className="flex items-center justify-center py-12 text-mil-dim">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading logs...
            </div>
          ) : filteredLogs.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-mil-dim">
              <Terminal className="mb-2 h-8 w-8 text-mil-dim" />
              <p>{errorsOnly ? 'No error lines in the current view' : filter ? 'No matching log lines' : 'No merged logs available yet'}</p>
              {!filter && sourceStatus && Object.values(sourceStatus).some((s) => !s.available) && (
                <div className="mt-3 max-w-md space-y-1 text-center text-[11px] text-zinc-600">
                  {Object.entries(sourceStatus).map(([name, info]) => (
                    !info.available && (
                      <p key={name} className="text-red-400/60">
                        <AlertTriangle className="mr-1 inline h-3 w-3" />
                        {name}: {info.reason?.replace(/_/g, ' ') || 'unavailable'}
                      </p>
                    )
                  ))}
                </div>
              )}
            </div>
          ) : (
            <div className="p-3" style={{ minHeight: `${totalHeight}px`, boxSizing: 'border-box' }}>
              {topSpacerHeight > 0 && <div style={{ height: `${topSpacerHeight}px` }} aria-hidden="true" />}
              {visibleLogs.map((log) => (
                <div
                  key={log.id}
                  data-testid="console-log-row"
                  className="grid grid-cols-[72px_132px_1fr] gap-3 py-1 hover:bg-zinc-900/50"
                  style={{ minHeight: `${ITEM_HEIGHT}px` }}
                >
                  <span className="pt-0.5 text-[11px] text-zinc-600">{log.formattedTs}</span>
                  <div className="pt-0.5">
                    <span className={`capitalize inline-flex items-center px-1.5 py-0.5 border text-[11px] font-mono ${log.sourceTone}`}>
                      {log.sourceLabel}
                    </span>
                  </div>
                  <div className={`whitespace-pre-wrap wrap-break-word ${log.lineClass}`}>
                    {log.text}
                  </div>
                </div>
              ))}
              {bottomSpacerHeight > 0 && <div style={{ height: `${bottomSpacerHeight}px` }} aria-hidden="true" />}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default ConsoleModule;
