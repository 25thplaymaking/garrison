import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useNavigate } from 'react-router';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import apiClient from '@/lib/apiClient';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from '@/components/ui/dialog';
import { Switch } from '@/components/ui/switch';
import {
  Server, Plus, Search, RefreshCw, Activity, AlertTriangle,
  Gauge, Clock, X, Save, ChevronDown, ChevronRight, Info,
  ShieldCheck, Zap,
} from 'lucide-react';
import { useAuth } from '@/context/AuthContext';
import { hasPermission, PERMISSIONS } from '@/utils/permissions';
import { isServerDegraded, normalizeServer } from '@/utils/serverStatus';
import ServerCard from '@/components/servers/ServerCard';
import { GarrisonLockup, GarrisonMark } from '@/components/brand/GarrisonMark';
import { formatApiError } from '@/utils/errorMessages';

const AUTO_REFRESH_MS = 15_000;
const METRICS_REFRESH_MS = 30_000;
const METRICS_STALE_MS = METRICS_REFRESH_MS * 3;
const PERIOD_API_MAP = { '1d': '24h', '7d': '7d', '30d': '30d' };
const PERIOD_RESOLUTION_MAP = { '1d': '5m', '7d': '1h', '30d': '1h' };
const SERVER_FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'online', label: 'Online' },
  { id: 'offline', label: 'Offline' },
  { id: 'degraded', label: 'Degraded' },
  { id: 'issues', label: 'Issues' },
];
const BOOT_LINES = ['POWERING NODE', 'ALLOCATING RUNTIME', 'SYNCING TELEMETRY', 'GARRISON LINK READY'];

function normalizeMetricPoint(point) {
  return {
    ...point,
    player_count: point.player_count ?? point.max_player_count ?? point.avg_player_count ?? null,
    fps: point.server_fps ?? point.avg_server_fps ?? point.fps ?? null,
  };
}

function buildMetricState(data) {
  const latest = data?.latest || null;
  const metrics = Array.isArray(data?.metrics) ? data.metrics : [];
  const sampledAt = latest?.timestamp || metrics.at(-1)?.timestamp || null;
  const sampledTime = sampledAt ? new Date(sampledAt).getTime() : Number.NaN;
  const hasSamples = Boolean(latest) || metrics.length > 0;

  if (!hasSamples) {
    return {
      status: 'empty',
      sampledAt: null,
      checkedAt: new Date().toISOString(),
      message: 'No telemetry samples are available yet.',
    };
  }

  return {
    status: Number.isFinite(sampledTime) && Date.now() - sampledTime > METRICS_STALE_MS ? 'stale' : 'fresh',
    sampledAt,
    checkedAt: new Date().toISOString(),
    message: null,
  };
}

function formatUptime(seconds) {
  if (!seconds && seconds !== 0) return '\u2014';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h >= 24) return `${Math.floor(h / 24)}d ${h % 24}h`;
  return `${h}h ${m}m`;
}

const SECTION_STORAGE_KEY = 'dashboard-sections';

/** Persist collapsible section state to localStorage. */
function loadSections() {
  try {
    const raw = localStorage.getItem(SECTION_STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function saveSections(state) {
  try { localStorage.setItem(SECTION_STORAGE_KEY, JSON.stringify(state)); } catch {}
}

function getDisplayStatus(server) {
  if (!server) return 'created';
  if (server.status === 'running' && isServerDegraded(server)) return 'degraded';
  return server.status || 'created';
}

function FrontierStartupOverlay({ serverName }) {
  const prefersReducedMotion = useReducedMotion();
  return (
    <motion.div
      className="absolute inset-0 z-30 flex items-center justify-center overflow-hidden border border-[rgba(232,131,58,0.18)] bg-mil-bg-deep/88 backdrop-blur-xs"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, y: -16 }}
      transition={{ duration: prefersReducedMotion ? 0 : 0.25 }}
      role="status"
      aria-live="polite"
    >
      <div className="absolute inset-0 c2-noise opacity-[0.06]" />
      <motion.div
        className="absolute inset-x-0 top-0 h-px bg-brand-light/70"
        animate={prefersReducedMotion ? undefined : { y: ['0%', '72vh'], opacity: [0.2, 0.8, 0.1] }}
        transition={{ duration: 1.5, repeat: Infinity, ease: 'easeInOut' }}
      />
      <div className="relative grid w-[min(92vw,780px)] gap-6 border border-[rgba(232,131,58,0.22)] bg-mil-bg-panel/88 p-6 shadow-[0_0_60px_rgba(232,131,58,0.12)] md:grid-cols-[220px_1fr]">
        <div className="flex items-center justify-center">
          <div className="relative flex h-44 w-44 items-center justify-center">
            {!prefersReducedMotion && (
              <>
                <motion.div className="absolute inset-0 rounded-full border border-brand-light/20" animate={{ rotate: 360 }} transition={{ duration: 5, repeat: Infinity, ease: 'linear' }} />
                <motion.div className="absolute inset-5 rounded-full border border-dashed border-mil-line-strong" animate={{ rotate: -360 }} transition={{ duration: 3.4, repeat: Infinity, ease: 'linear' }} />
                <motion.div className="absolute inset-12 rounded-full border-2 border-t-brand-light border-r-transparent border-b-[#7d7d7d] border-l-transparent" animate={{ rotate: 360 }} transition={{ duration: 1.2, repeat: Infinity, ease: 'linear' }} />
              </>
            )}
            <div className="relative flex h-24 w-24 items-center justify-center rounded-full border border-[rgba(232,131,58,0.26)] bg-mil-bg-deep">
              <GarrisonMark size={64} />
            </div>
          </div>
        </div>
        <div className="flex min-w-0 flex-col justify-center">
          <p className="text-xs font-medium text-mil-muted">Server boot sequence</p>
          <h2 className="mt-2 truncate text-2xl font-semibold text-mil-bright" style={{ fontFamily: "var(--font-heading)" }}>
            {serverName || 'Managed Node'}
          </h2>
          <div className="mt-4 space-y-2">
            {BOOT_LINES.map((line, index) => (
              <motion.div
                key={line}
                className="flex items-center gap-3 text-xs text-mil-muted"
                initial={prefersReducedMotion ? false : { opacity: 0, x: -10 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: prefersReducedMotion ? 0 : index * 0.18 }}
                style={{ fontFamily: "var(--font-mono)" }}
              >
                <span className="h-1.5 w-1.5 rounded-full bg-brand-light" />
                {line}
              </motion.div>
            ))}
          </div>
          <motion.div
            className="mt-6 text-[#efefef]"
            initial={prefersReducedMotion ? false : { opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: prefersReducedMotion ? 0 : 0.65 }}
          >
            <GarrisonLockup size={30} />
          </motion.div>
        </div>
      </div>
    </motion.div>
  );
}

/** Collapsible section header — mirrors AdminLayout SidebarGroup pattern. */
function SectionHeader({ label, open, onToggle, controls }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      aria-controls={controls}
      className="flex min-h-11 w-full items-center gap-2 py-2 text-[11px] font-bold tracking-[0.06em] text-mil-muted transition-colors hover:text-brand-light"
      style={{ fontFamily: "var(--font-condensed)" }}
    >
      {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
      {label}
    </button>
  );
}

const EMPTY_FORM = {
  name: '',
  description: '',
  auto_restart: false,
  max_restart_attempts: 3,
  log_stats_enabled: true,
  max_fps: 120,
  startup_parameters: '',
  tags: [],
  sat_enabled: true,
};

function ServerDashboard() {
  const { user } = useAuth();
  const navigate = useNavigate();

  /* ── server state ──────────────────────────────────────────────────── */
  const [servers, setServers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [activeFilter, setActiveFilter] = useState('all');
  const [refreshing, setRefreshing] = useState(false);
  const [actionError, setActionError] = useState(null);
  const [pendingActions, setPendingActions] = useState({});
  const [startupOverlay, setStartupOverlay] = useState(null);
  const [lastRefreshedAt, setLastRefreshedAt] = useState(null);

  /* ── metrics state ─────────────────────────────────────────────────── */
  const [serverMetrics, setServerMetrics] = useState({});
  const [serverMetricStates, setServerMetricStates] = useState({});
  const [serverPeriods, setServerPeriods] = useState({});
  const periodsRef = useRef(serverPeriods);
  const serverListRequestEpochRef = useRef(0);
  const metricsRequestEpochRef = useRef({});
  const actionInFlightRef = useRef(new Set());
  useEffect(() => { periodsRef.current = serverPeriods; }, [serverPeriods]);

  /* ── collapsible section state (persisted) ─────────────────────────── */
  const [sections, setSections] = useState(() => {
    const stored = loadSections();
    return stored ?? { status: true, servers: true };
  });
  const toggleSection = useCallback((key) => {
    setSections((prev) => {
      const next = { ...prev, [key]: !prev[key] };
      saveSections(next);
      return next;
    });
  }, []);


  /* ── create-modal state ────────────────────────────────────────────── */
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [tagInput, setTagInput] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState(null);

  const canManage = user && hasPermission(user.role, PERMISSIONS.MANAGE_SERVERS);

  /* ── fetch servers ─────────────────────────────────────────────────── */
  const fetchServers = useCallback(async (opts = {}) => {
    const { silent = false } = opts;
    const requestEpoch = ++serverListRequestEpochRef.current;
    if (!silent) setLoading(true);

    try {
      const res = await apiClient.get('/servers');
      if (requestEpoch !== serverListRequestEpochRef.current) return;
      setServers(Array.isArray(res.data) ? res.data.map(normalizeServer) : []);
      setLastRefreshedAt(new Date());
      setError(null);
    } catch (err) {
      if (requestEpoch !== serverListRequestEpochRef.current) return;
      console.error('Failed to fetch servers:', err);
      if (!silent) setError(formatApiError(err, 'Failed to load servers.'));
    } finally {
      if (requestEpoch === serverListRequestEpochRef.current) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => { fetchServers(); }, [fetchServers]);

  // The panel runs at most this many server instances (MAX_SERVER_INSTANCES on the backend);
  // every listed server counts, so the live list gives "in use".
  const [capacityMax, setCapacityMax] = useState(null);
  useEffect(() => {
    apiClient.get('/servers/capacity')
      .then(({ data }) => { if (Number.isInteger(data?.max)) setCapacityMax(data.max); })
      .catch(() => {});
  }, []);
  const atCapacity = capacityMax != null && servers.length >= capacityMax;

  useEffect(() => {
    const id = setInterval(() => {
      if (document.visibilityState !== 'hidden') fetchServers({ silent: true });
    }, AUTO_REFRESH_MS);
    return () => clearInterval(id);
  }, [fetchServers]);

  /* ── fetch metrics for all servers ─────────────────────────────────── */
  const fetchAllMetrics = useCallback(async (serverIds) => {
    if (!serverIds || serverIds.length === 0) return;
    setServerMetricStates((prev) => {
      const next = { ...prev };
      serverIds.forEach((serverId) => {
        if (!next[serverId]) next[serverId] = { status: 'loading', sampledAt: null, checkedAt: null, message: null };
      });
      return next;
    });
    const requestEpochs = Object.fromEntries(serverIds.map((serverId) => {
      const nextEpoch = (metricsRequestEpochRef.current[serverId] || 0) + 1;
      metricsRequestEpochRef.current[serverId] = nextEpoch;
      return [serverId, nextEpoch];
    }));
    const currentPeriods = periodsRef.current;
    const results = {};

    await Promise.allSettled(
      serverIds.map(async (serverId) => {
        const period = currentPeriods[serverId] || '1d';
        const apiPeriod = PERIOD_API_MAP[period] || '24h';
        try {
          const response = await apiClient.get(`/servers/${serverId}/metrics`, {
            params: { period: apiPeriod, resolution: PERIOD_RESOLUTION_MAP[period] || '5m' },
          });
          results[serverId] = {
            ok: true,
            metrics: {
              latest: response.data?.latest ? normalizeMetricPoint(response.data.latest) : null,
              timeseries: (response.data?.metrics ?? []).map(normalizeMetricPoint),
            },
            state: buildMetricState(response.data),
          };
        } catch (err) {
          results[serverId] = {
            ok: false,
            message: formatApiError(err, 'Telemetry request failed.'),
          };
        }
      }),
    );

    const currentResults = Object.fromEntries(
      Object.entries(results).filter(([serverId]) => (
        requestEpochs[serverId] === metricsRequestEpochRef.current[serverId]
      )),
    );
    const successfulMetrics = Object.fromEntries(
      Object.entries(currentResults)
        .filter(([, result]) => result.ok)
        .map(([serverId, result]) => [serverId, result.metrics]),
    );
    if (Object.keys(successfulMetrics).length > 0) {
      setServerMetrics((prev) => ({ ...prev, ...successfulMetrics }));
    }
    if (Object.keys(currentResults).length > 0) {
      setServerMetricStates((prev) => {
        const next = { ...prev };
        Object.entries(currentResults).forEach(([serverId, result]) => {
          if (result.ok) {
            next[serverId] = result.state;
            return;
          }
          const previous = prev[serverId];
          const hasLastKnownData = previous && ['fresh', 'stale'].includes(previous.status);
          next[serverId] = {
            ...previous,
            status: hasLastKnownData ? 'stale' : 'error',
            checkedAt: new Date().toISOString(),
            message: result.message,
          };
        });
        return next;
      });
    }
  }, []); // stable — reads periods via ref

  // Inventory objects are replaced on every 15s poll even when the fleet is
  // unchanged. Key metrics work only to the primitive server-id set so those
  // inventory refreshes do not restart the timer or duplicate every request.
  const serverIdsKey = useMemo(
    () => servers.map((server) => server.id).filter(Boolean).join('\u001f'),
    [servers],
  );

  useEffect(() => {
    if (!serverIdsKey) return undefined;
    const serverIds = serverIdsKey.split('\u001f');
    const refreshMetrics = () => {
      if (document.visibilityState !== 'hidden') fetchAllMetrics(serverIds);
    };
    refreshMetrics();
    const id = setInterval(refreshMetrics, METRICS_REFRESH_MS);
    return () => clearInterval(id);
  }, [serverIdsKey, fetchAllMetrics]);

  const handleDashboardRefresh = useCallback(async () => {
    const serverIds = serverIdsKey ? serverIdsKey.split('\u001f') : [];
    setRefreshing(true);
    try {
      await Promise.allSettled([
        fetchServers({ silent: true }),
        fetchAllMetrics(serverIds),
      ]);
    } finally {
      setRefreshing(false);
    }
  }, [fetchAllMetrics, fetchServers, serverIdsKey]);

  /* ── period change (per-server) ────────────────────────────────────── */
  const handlePeriodChange = useCallback(async (serverId, newPeriod) => {
    const requestEpoch = (metricsRequestEpochRef.current[serverId] || 0) + 1;
    metricsRequestEpochRef.current[serverId] = requestEpoch;
    const previousPeriod = serverPeriods[serverId];
    periodsRef.current = { ...periodsRef.current, [serverId]: newPeriod };
    setServerPeriods((prev) => ({ ...prev, [serverId]: newPeriod }));
    setServerMetricStates((prev) => ({
      ...prev,
      [serverId]: {
        ...(prev[serverId] || {}),
        refreshing: true,
      },
    }));
    const apiPeriod = PERIOD_API_MAP[newPeriod] || '24h';
    try {
      const res = await apiClient.get(`/servers/${serverId}/metrics`, {
        params: { period: apiPeriod, resolution: PERIOD_RESOLUTION_MAP[newPeriod] || '5m' },
      });
      if (requestEpoch !== metricsRequestEpochRef.current[serverId]) return;
      setServerMetrics((prev) => ({
        ...prev,
        [serverId]: {
          latest: res.data?.latest ? normalizeMetricPoint(res.data.latest) : null,
          timeseries: (res.data?.metrics ?? []).map(normalizeMetricPoint),
        },
      }));
      setServerMetricStates((prev) => ({
        ...prev,
        [serverId]: { ...buildMetricState(res.data), refreshing: false },
      }));
    } catch (err) {
      console.error(`Failed to fetch metrics for period ${newPeriod}:`, err);
      if (requestEpoch === metricsRequestEpochRef.current[serverId]) {
        // Revert the selector so it doesn't silently point at a period whose
        // chart data never actually loaded (the old timeseries stays displayed).
        periodsRef.current = { ...periodsRef.current, [serverId]: previousPeriod };
        setServerPeriods((prev) => ({ ...prev, [serverId]: previousPeriod }));
        setActionError(formatApiError(err, `Failed to load metrics for the selected period.`));
        setServerMetricStates((prev) => {
          const previous = prev[serverId];
          return {
            ...prev,
            [serverId]: {
              ...previous,
              status: previous && ['fresh', 'stale'].includes(previous.status) ? 'stale' : 'error',
              checkedAt: new Date().toISOString(),
              message: formatApiError(err, 'Telemetry request failed.'),
              refreshing: false,
            },
          };
        });
      }
    }
  }, [serverPeriods]);

  /* ── quick actions (start / stop / restart) ────────────────────────── */
  const handleAction = useCallback(async (serverId, action) => {
    if (actionInFlightRef.current.has(serverId)) return;
    actionInFlightRef.current.add(serverId);
    setPendingActions((prev) => ({ ...prev, [serverId]: action }));
    const targetServer = servers.find((server) => server.id === serverId);
    if (action === 'start') {
      setStartupOverlay({ serverId, serverName: targetServer?.name || 'Managed Node' });
    }
    try {
      await apiClient.post(`/servers/${serverId}/${action}`, null, {
        validateStatus: (s) => s < 400,
      });
      setActionError(null);
      await fetchServers({ silent: true });
      if (action === 'start') {
        window.setTimeout(() => setStartupOverlay((current) => (
          current?.serverId === serverId ? null : current
        )), 1250);
      }
    } catch (err) {
      console.error(`Server ${action} failed:`, err);
      setActionError(`${targetServer?.name || serverId}: ${formatApiError(err, `Failed to ${action} server.`)}`);
      if (action === 'start') setStartupOverlay(null);
    } finally {
      actionInFlightRef.current.delete(serverId);
      setPendingActions((prev) => {
        const next = { ...prev };
        delete next[serverId];
        return next;
      });
    }
  }, [fetchServers, servers, user]);

  const onStart   = useCallback((id) => handleAction(id, 'start'),   [handleAction]);
  const onStop    = useCallback((id) => handleAction(id, 'stop'),    [handleAction]);
  const onRestart = useCallback((id) => handleAction(id, 'restart'), [handleAction]);

  /* ── create server ─────────────────────────────────────────────────── */
  const handleCreate = useCallback(async () => {
    if (!form.name.trim()) return;
    setCreating(true);
    setCreateError(null);
    try {
      const createPayload = {
        name: form.name.trim(),
        description: form.description.trim(),
        tags: form.tags,
        auto_restart: form.auto_restart,
        max_restart_attempts: form.auto_restart ? form.max_restart_attempts : undefined,
        log_stats_enabled: form.log_stats_enabled,
        max_fps: Math.max(30, parseInt(form.max_fps, 10) || 120),
        startup_parameters: String(form.startup_parameters || '')
          .split(/\r?\n|,/)
          .map((value) => value.trim())
          .filter(Boolean),
        sat_enabled: form.sat_enabled,
      };
      const res = await apiClient.post('/servers', createPayload, {
        validateStatus: (s) => s < 400,
      });
      const createdServer = normalizeServer(res.data);
      if (createdServer.deployment_state !== 'created') {
        setCreateError(
          createdServer.summary_message
          || createdServer.last_docker_error
          || 'Server creation failed before the container was created.'
        );
        await fetchServers({ silent: true });
        return;
      }
      setShowCreateModal(false);
      setForm(EMPTY_FORM);
      setTagInput('');
      await fetchServers({ silent: true });
      navigate(`/servers/${createdServer.id}`);
    } catch (err) {
      console.error('Failed to create server:', err);
      setCreateError(formatApiError(err, 'Failed to create server.'));
      // The API stores the record before provisioning, so a failed create
      // still leaves a server behind. Show it now; retrying blind made
      // duplicates.
      await fetchServers({ silent: true });
    } finally {
      setCreating(false);
    }
  }, [fetchServers, form, user]);

  const addTag = useCallback(() => {
    const tag = tagInput.trim();
    if (tag && !form.tags.includes(tag)) {
      setForm((prev) => ({ ...prev, tags: [...prev.tags, tag] }));
    }
    setTagInput('');
  }, [tagInput, form.tags]);

  const removeTag = useCallback((tag) => {
    setForm((prev) => ({ ...prev, tags: prev.tags.filter((t) => t !== tag) }));
  }, []);

  /* ── derived data ──────────────────────────────────────────────────── */
  const stats = useMemo(() => {
    const total   = servers.length;
    const running = servers.filter((s) => getDisplayStatus(s) === 'running').length;
    const criticalIssues = servers.filter((s) => ['error', 'crash_loop'].includes(s.status)).length;
    const degraded = servers.filter((s) => getDisplayStatus(s) === 'degraded').length;
    const offline = servers.filter((s) => ['stopped', 'created'].includes(getDisplayStatus(s))).length;
    const issues = criticalIssues + degraded;
    const posture = criticalIssues > 0 ? 'Attention Required' : degraded > 0 ? 'Degraded' : running > 0 ? 'Online' : 'Standby';
    return { total, running, issues, criticalIssues, degraded, offline, posture };
  }, [servers]);

  const dashboardAverages = useMemo(() => {
    // Only servers that are up right now: a stopped server keeps its last
    // sample, which would otherwise pass for a live FPS or runtime age.
    const latestMetrics = servers
      .filter((server) => ['running', 'degraded'].includes(getDisplayStatus(server)))
      .map((server) => serverMetrics[server.id]?.latest)
      .filter(Boolean);

    const averageOf = (values) => {
      const numeric = values.filter((value) => Number.isFinite(value));
      if (!numeric.length) return null;
      return numeric.reduce((sum, value) => sum + value, 0) / numeric.length;
    };

    const maxOf = (values) => {
      const numeric = values.filter((value) => Number.isFinite(value));
      if (!numeric.length) return null;
      return Math.max(...numeric);
    };

    return {
      fps: averageOf(latestMetrics.map((metric) => metric.server_fps ?? metric.fps ?? null)),
      maxUptime: maxOf(latestMetrics.map((metric) => metric.uptime_seconds ?? null)),
    };
  }, [serverMetrics, servers]);

  const filteredServers = useMemo(() => {
    const filteredByPosture = servers.filter((server) => {
      const status = getDisplayStatus(server);
      if (activeFilter === 'online') return status === 'running';
      if (activeFilter === 'offline') return ['stopped', 'created'].includes(status);
      if (activeFilter === 'degraded') return status === 'degraded';
      if (activeFilter === 'issues') return ['error', 'crash_loop'].includes(status) || status === 'degraded';
      return true;
    });
    if (!searchQuery.trim()) return filteredByPosture;
    const q = searchQuery.toLowerCase();
    return filteredByPosture.filter((s) => `${s.name || ''} ${s.description || ''} ${s.container_name || ''}`.toLowerCase().includes(q));
  }, [activeFilter, servers, searchQuery]);

  /* ── summary bar cards ─────────────────────────────────────────────── */
  const summaryCards = useMemo(() => [
    {
      label: 'Total Servers',
      value: stats.total,
      detail: 'Managed nodes',
      icon: Server,
      color: 'text-brand-light',
      tone: 'border-[rgba(232,131,58,0.16)]',
      glow: '',
    },
    {
      label: 'Healthy Online',
      value: stats.running,
      detail: `of ${stats.total} servers`,
      icon: Activity,
      color: 'text-brand-light',
      tone: 'border-[rgba(34,197,94,0.24)]',
      glow: 'shadow-[0_0_10px_rgba(232,131,58,0.1)]',
    },
    {
      label: 'Issues',
      value: stats.issues,
      detail: stats.issues > 0 ? 'Review required' : 'Nominal',
      icon: AlertTriangle,
      color: stats.criticalIssues > 0 ? 'text-brand-light' : stats.degraded > 0 ? 'text-[#ffaa00]' : 'text-mil-muted',
      tone: stats.criticalIssues > 0 ? 'border-[rgba(232,131,58,0.24)]' : stats.degraded > 0 ? 'border-[rgba(255,170,0,0.24)]' : 'border-[rgba(232,131,58,0.12)]',
      glow: stats.criticalIssues > 0 ? 'shadow-[0_0_10px_rgba(232,131,58,0.15)]' : '',
    },
    {
      label: 'Avg FPS',
      value: dashboardAverages.fps != null ? `${dashboardAverages.fps.toFixed(1)}` : '\u2014',
      detail: dashboardAverages.fps != null ? 'Running servers' : 'Nothing running',
      icon: Gauge,
      color: 'text-brand-light',
      tone: 'border-[rgba(232,131,58,0.16)]',
      glow: '',
    },
    {
      label: 'Max Uptime',
      value: dashboardAverages.maxUptime != null ? formatUptime(dashboardAverages.maxUptime) : '\u2014',
      detail: dashboardAverages.maxUptime != null && dashboardAverages.maxUptime > 48 * 3600 ? 'Restart advised' : 'Runtime age',
      icon: Clock,
      color: dashboardAverages.maxUptime != null && dashboardAverages.maxUptime > 48 * 3600 ? 'text-amber-400' : 'text-mil-muted',
      tone: dashboardAverages.maxUptime != null && dashboardAverages.maxUptime > 48 * 3600 ? 'border-[rgba(255,170,0,0.24)]' : 'border-[rgba(232,131,58,0.16)]',
      glow: '',
    },
  ], [dashboardAverages.fps, dashboardAverages.maxUptime, stats]);

  const openCreateModal = useCallback(() => {
    setForm(EMPTY_FORM);
    setTagInput('');
    setCreateError(null);
    setShowCreateModal(true);
  }, []);

  const handleServerNavigate = useCallback((serverId) => {
    navigate(`/servers/${serverId}`);
  }, [navigate]);

  /* ── render ────────────────────────────────────────────────────────── */

  return (
    <div className="relative space-y-6">
      <AnimatePresence>
        {startupOverlay && (
          <FrontierStartupOverlay
            key={startupOverlay.serverId}
            serverName={startupOverlay.serverName}
          />
        )}
      </AnimatePresence>

      {/* ── Header ──────────────────────────────────────────────────── */}
      {/* One compact band: the fleet's posture and the two actions. The server
          list is the page; on a phone the first server is now above the fold. */}
      <div className="relative corner-bracket border border-[rgba(232,131,58,0.16)] bg-mil-bg-deep px-4 py-4 sm:px-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="min-w-0">
            <h1 className="text-2xl font-semibold text-mil-bright sm:text-3xl" style={{ fontFamily: "var(--font-heading)" }}>
              Fleet Operations
            </h1>
            <p className="mt-1 hidden max-w-2xl text-sm text-mil-muted sm:block">
              Posture, runtime health and quick actions for every managed server.
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-2 text-xs" style={{ fontFamily: "var(--font-mono)" }}>
              <span className={`inline-flex items-center gap-2 border px-2.5 py-1 ${
                stats.issues > 0
                  ? 'border-red-500/30 bg-red-500/10 text-red-300'
                  : stats.degraded > 0
                    ? 'border-amber-500/30 bg-amber-500/10 text-amber-300'
                    : 'border-[rgba(232,131,58,0.3)] bg-[rgba(232,131,58,0.08)] text-brand-light'
              }`}>
                {stats.issues > 0 ? <AlertTriangle className="h-3.5 w-3.5" /> : <ShieldCheck className="h-3.5 w-3.5" />}
                {stats.posture}
              </span>
              <span className="inline-flex items-center gap-2 border border-[rgba(232,131,58,0.12)] bg-mil-bg-panel/70 px-2.5 py-1 text-mil-dim">
                <span className="status-dot status-dot-online" />
                Synced {lastRefreshedAt ? lastRefreshedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—'} · every 15s
              </span>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="command"
              disabled={refreshing}
              onClick={handleDashboardRefresh}
              aria-label="Refresh server dashboard inventory and telemetry"
            >
              <RefreshCw className={refreshing ? 'animate-spin' : ''} aria-hidden="true" />
              Refresh
            </Button>

            {canManage && capacityMax != null && (
              <span
                className={`text-xs ${atCapacity ? 'text-amber-300' : 'text-mil-dim'}`}
                data-testid="server-capacity"
                title={`The domain runs at most ${capacityMax} server instances.`}
              >
                {servers.length} of {capacityMax} instances
              </span>
            )}
            {canManage && (
              <Button
                type="button"
                variant="commandPrimary"
                onClick={openCreateModal}
                disabled={atCapacity}
                title={atCapacity ? `All ${capacityMax} server instances are in use. Delete one before creating another.` : undefined}
              >
                <Plus aria-hidden="true" />
                New Server
              </Button>
            )}
          </div>
        </div>
      </div>

      {/* ── Error banners ───────────────────────────────────────────── */}
      {error && (
        <div role="alert" className="flex items-center gap-3 border border-red-500/30 bg-red-500/8 px-4 py-3 text-sm text-red-200">
          <AlertTriangle className="h-5 w-5 shrink-0" />
          <span style={{ fontFamily: "var(--font-mono)" }}>{error}</span>
          <Button type="button" variant="commandDanger" onClick={() => fetchServers()} className="ml-auto">
            Retry
          </Button>
        </div>
      )}

      {actionError && (
        <div role="alert" className="flex items-center gap-3 border border-red-500/30 bg-red-500/8 px-4 py-3 text-sm text-red-200">
          <AlertTriangle className="h-5 w-5 shrink-0" />
          <span style={{ fontFamily: "var(--font-mono)" }}>{actionError}</span>
          <Button type="button" variant="commandDanger" onClick={() => setActionError(null)} className="ml-auto">
            Dismiss
          </Button>
        </div>
      )}

      {/* ── Loading skeleton ────────────────────────────────────────── */}
      {loading && (
        <div className="space-y-6" aria-busy="true">
          <span className="sr-only" role="status" aria-live="polite">Loading server fleet</span>
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="relative animate-pulse border border-[rgba(232,131,58,0.08)] bg-mil-bg-panel p-0">
                <div className="px-5 pt-4 pb-2">
                  <div className="h-4 w-20 bg-mil-bg-elevated" />
                </div>
                <div className="px-5 pb-5">
                  <div className="h-7 w-10 bg-mil-bg-elevated" />
                </div>
              </div>
            ))}
          </div>
          <div className="grid grid-cols-1 gap-4 sm:gap-6 lg:grid-cols-2">
            {Array.from({ length: 2 }).map((_, i) => (
              <div key={i} className="relative animate-pulse border border-[rgba(232,131,58,0.08)] bg-mil-bg-panel p-6 space-y-3">
                <div className="h-5 w-3/4 bg-mil-bg-elevated" />
                <div className="h-4 w-1/2 bg-mil-bg-elevated" />
                <div className="h-4 w-2/3 bg-mil-bg-elevated" />
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Main content ────────────────────────────────────────────── */}
      {!loading && (
        <>
          {/* ── STATUS OVERVIEW (collapsible) ───────────────────────── */}
          <SectionHeader
            label="STATUS OVERVIEW"
            open={sections.status}
            onToggle={() => toggleSection('status')}
            controls="fleet-status-overview"
          />
          {sections.status && (
          <div id="fleet-status-overview">
            <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-5">
              {summaryCards.map((stat) => {
                const Icon = stat.icon;
                return (
                  <motion.div
                    key={stat.label}
                    whileHover={{ y: -2 }}
                    className={`relative overflow-hidden corner-bracket border ${stat.tone} bg-mil-bg-panel/90 shadow-xl ${stat.glow}`}
                  >
                    <div className="absolute inset-x-0 top-0 h-px bg-linear-to-r from-transparent via-brand-light/35 to-transparent" />
                    <div className="flex items-center justify-between px-5 pt-4 pb-2">
                      <span
                        className="text-xs font-medium text-mil-muted capitalize"
                      >
                        {stat.label}
                      </span>
                      <div className="border border-[rgba(232,131,58,0.15)] bg-mil-bg-deep p-2">
                        <Icon className={`h-4 w-4 ${stat.color}`} />
                      </div>
                    </div>
                    <div className="px-5 pb-5">
                      <div
                        className="text-3xl font-bold text-brand-light"
                        style={{ fontFamily: "var(--font-mono)" }}
                      >
                        {stat.value}
                      </div>
                      <div className="mt-1 text-xs text-mil-muted font-medium capitalize">
                        {stat.detail}
                      </div>
                    </div>
                  </motion.div>
                );
              })}
            </div>

            {dashboardAverages.maxUptime != null && dashboardAverages.maxUptime > 48 * 3600 && (
              <div className="mt-3 flex items-start gap-2.5 rounded border border-amber-500/20 bg-amber-500/5 px-4 py-3">
                <Info className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
                <p className="text-xs leading-relaxed text-amber-300/90">
                  One or more servers have been running for over 48 hours. A restart or full shutdown and restart is recommended to prevent memory leaks and ensure continued stability.
                </p>
              </div>
            )}
          </div>
          )}

          {/* ── SERVERS (collapsible) ────────────────────────────────── */}
          <SectionHeader
            label="SERVERS"
            open={sections.servers}
            onToggle={() => toggleSection('servers')}
            controls="fleet-server-list"
          />
          {sections.servers && (
          <div id="fleet-server-list" className="space-y-6">
            {/* Search and filters */}
            <div className="relative overflow-hidden border border-[rgba(232,131,58,0.12)] bg-mil-bg-panel/75 p-3">
              <div className="absolute inset-0 bg-[linear-gradient(90deg,rgba(232,131,58,0.04)_1px,transparent_1px)] bg-size-[32px_32px] opacity-70" />
              <div className="relative flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
                <div className="relative min-w-[240px] flex-1">
                  <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-mil-dim" />
                  <Label htmlFor="fleet-server-search" className="sr-only">Search managed servers</Label>
                  <Input
                    id="fleet-server-search"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="Search by name, description, or container..."
                    className="h-11 border-[rgba(232,131,58,0.15)] bg-mil-bg-deep/88 pl-10 text-mil-fg placeholder:text-mil-dim focus-visible:ring-[rgba(232,131,58,0.3)] rounded-none"
                    style={{ fontFamily: "var(--font-mono)" }}
                  />
                </div>
                <div className="flex max-w-full gap-2 overflow-x-auto">
                  {SERVER_FILTERS.map((filter) => (
                    <button
                      key={filter.id}
                      type="button"
                      onClick={() => setActiveFilter(filter.id)}
                      aria-pressed={activeFilter === filter.id}
                      className={`capitalize min-h-11 shrink-0 border px-3 py-2 text-[11px] font-bold transition-colors ${
 activeFilter === filter.id
 ? 'border-[rgba(232,131,58,0.35)] bg-[rgba(232,131,58,0.12)] text-brand-light'
 : 'border-[rgba(232,131,58,0.1)] text-mil-muted hover:border-[rgba(232,131,58,0.24)] hover:text-mil-fg'
 }`}
                      style={{ fontFamily: "var(--font-condensed)" }}
                    >
                      {filter.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {/* Sparse fleets use the full rail; cards split only when both remain useful widths. */}
            {filteredServers.length > 0 ? (
              <motion.div
                layout
                className="grid gap-4 sm:gap-6"
                style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 34rem), 1fr))' }}
              >
                {filteredServers.map((server) => (
                  <ServerCard
                    key={server.id}
                    server={server}
                    metrics={serverMetrics[server.id] ?? null}
                    metricsState={serverMetricStates[server.id] ?? null}
                    period={serverPeriods[server.id] || '1d'}
                    onPeriodChange={handlePeriodChange}
                    onStart={onStart}
                    onStop={onStop}
                    onRestart={onRestart}
                    onNavigate={handleServerNavigate}
                    pendingAction={pendingActions[server.id] ?? null}
                  />
                ))}
              </motion.div>
            ) : (
              <div className="relative corner-bracket border border-[rgba(232,131,58,0.1)] bg-mil-bg-panel">
                <div className="flex flex-col items-center justify-center py-16 text-center px-5">
                  <Activity className="mb-4 h-12 w-12 text-mil-dim" />
                  <p className="text-lg font-semibold text-mil-fg" style={{ fontFamily: "var(--font-heading)" }}>
                    {searchQuery ? 'No servers match your search' : servers.length > 0 ? 'No servers in this view' : 'No servers configured'}
                  </p>
                  <p className="mt-1 text-sm text-mil-dim" style={{ fontFamily: "var(--font-body)" }}>
                    {searchQuery ? 'Try a different search term.' : servers.length > 0 ? 'Pick another filter to see the rest of the fleet.' : 'Add a server to get started.'}
                  </p>
                  {!searchQuery && servers.length === 0 && canManage && (
                    <Button type="button" variant="command" className="mt-4" onClick={openCreateModal}>
                      <Plus aria-hidden="true" />
                      New Server
                    </Button>
                  )}
                </div>
              </div>
            )}
          </div>
          )}

          {/* Live indicator */}
          <div className="flex items-center justify-end gap-2 text-xs text-mil-dim" style={{ fontFamily: "var(--font-mono)" }}>
            <Zap className="h-3.5 w-3.5 text-brand" />
            {filteredServers.length} visible / {servers.length} total nodes
          </div>
        </>
      )}

      {/* ── Create Server Modal ─────────────────────────────────────── */}
      <Dialog open={showCreateModal} onOpenChange={setShowCreateModal}>
        <DialogContent className="flex max-h-[calc(100dvh-2rem)] w-[95vw] flex-col border-[rgba(232,131,58,0.15)] bg-mil-bg-panel rounded-none sm:max-w-lg">
          <DialogHeader className="shrink-0">
            <DialogTitle
              className="text-xl font-semibold text-mil-bright"
              style={{ fontFamily: "var(--font-heading)" }}
            >
              New server
            </DialogTitle>
            <DialogDescription className="text-sm text-mil-muted" style={{ fontFamily: "var(--font-body)" }}>
              Create the dashboard record and container now. First-boot provisioning continues inside the server workspace after deployment succeeds.
            </DialogDescription>
          </DialogHeader>

          <div className="-mr-2 min-h-0 flex-1 space-y-4 overflow-y-auto py-2 pr-2">
            {/* Name */}
            <div className="space-y-2">
              <Label htmlFor="srv-name" className="text-xs text-mil-muted font-medium">
                Server Name <span className="text-brand">*</span>
              </Label>
              <Input
                id="srv-name"
                value={form.name}
                onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
                placeholder="e.g. US East #1"
                className="border-[rgba(232,131,58,0.15)] bg-mil-bg-deep text-mil-fg placeholder:text-mil-dim rounded-none"
                style={{ fontFamily: "var(--font-mono)" }}
              />
            </div>

            {/* Description */}
            <div className="space-y-2">
              <Label htmlFor="srv-desc" className="text-xs text-mil-muted font-medium">
                Description
              </Label>
              <Textarea
                id="srv-desc"
                value={form.description}
                onChange={(e) => setForm((p) => ({ ...p, description: e.target.value }))}
                placeholder="Optional server description..."
                className="border-[rgba(232,131,58,0.15)] bg-mil-bg-deep text-mil-fg placeholder:text-mil-dim rounded-none"
                style={{ fontFamily: "var(--font-mono)" }}
                rows={3}
              />
            </div>

            {/* Auto Restart toggle */}
            <div className="flex items-center justify-between border border-[rgba(232,131,58,0.1)] bg-mil-bg-deep px-4 py-3">
              <Label htmlFor="srv-autorestart" className="text-xs text-mil-muted font-medium">
                Auto Restart
              </Label>
              <Switch
                id="srv-autorestart"
                checked={form.auto_restart}
                onCheckedChange={(v) => setForm((p) => ({ ...p, auto_restart: v }))}
              />
            </div>

            {/* Max Restart Attempts — only when auto_restart is on */}
            {form.auto_restart && (
              <div className="space-y-2">
                <Label htmlFor="srv-maxrestart" className="text-xs text-mil-muted font-medium">
                  Max Restart Attempts
                </Label>
                <Input
                  id="srv-maxrestart"
                  type="number"
                  min={1}
                  max={99}
                  value={form.max_restart_attempts}
                  onChange={(e) =>
                    setForm((p) => ({
                      ...p,
                      max_restart_attempts: parseInt(e.target.value, 10) || 1,
                    }))
                  }
                  className="w-full sm:w-24 border-[rgba(232,131,58,0.15)] bg-mil-bg-deep text-mil-fg rounded-none"
                  style={{ fontFamily: "var(--font-mono)" }}
                />
              </div>
            )}

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="flex items-center justify-between border border-[rgba(232,131,58,0.1)] bg-mil-bg-deep px-4 py-3">
                <Label htmlFor="srv-logstats" className="text-xs text-mil-muted font-medium">
                  Enable logStats
                </Label>
                <Switch
                  id="srv-logstats"
                  checked={form.log_stats_enabled}
                  onCheckedChange={(value) => setForm((prev) => ({ ...prev, log_stats_enabled: value }))}
                />
              </div>
              <div className="flex items-center justify-between border border-[rgba(232,131,58,0.1)] bg-mil-bg-deep px-4 py-3">
                <div>
                  <Label htmlFor="srv-sat" className="text-xs text-mil-muted font-medium">
                    Server Admin Tools
                  </Label>
                  <p className="mt-0.5 text-[11px] text-mil-dim">Auto-inject the SAT mod for admin tooling</p>
                </div>
                <Switch
                  id="srv-sat"
                  checked={form.sat_enabled}
                  onCheckedChange={(value) => setForm((prev) => ({ ...prev, sat_enabled: value }))}
                />
              </div>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="srv-maxfps" className="text-xs text-mil-muted font-medium">
                  Max FPS
                </Label>
                <Input
                  id="srv-maxfps"
                  type="number"
                  min={30}
                  max={240}
                  value={form.max_fps}
                  onChange={(e) => setForm((prev) => ({ ...prev, max_fps: parseInt(e.target.value, 10) || 120 }))}
                  className="border-[rgba(232,131,58,0.15)] bg-mil-bg-deep text-mil-fg rounded-none"
                  style={{ fontFamily: "var(--font-mono)" }}
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="srv-startup-params" className="text-xs text-mil-muted font-medium">
                Extra Startup Parameters
              </Label>
              <Textarea
                id="srv-startup-params"
                value={form.startup_parameters}
                onChange={(e) => setForm((prev) => ({ ...prev, startup_parameters: e.target.value }))}
                placeholder="-profileVerbose&#10;-SomeFlag value"
                className="border-[rgba(232,131,58,0.15)] bg-mil-bg-deep text-mil-fg placeholder:text-mil-dim rounded-none"
                style={{ fontFamily: "var(--font-mono)" }}
                rows={3}
              />
              <p className="text-xs text-mil-dim" style={{ fontFamily: "var(--font-body)" }}>
                One parameter per line. <code className="text-brand-light">-logstats</code> and the default telemetry flags are managed separately so the dashboard stays ready by default.
              </p>
            </div>

            {/* Tags */}
            <div className="space-y-2">
              <Label className="text-xs text-mil-muted font-medium">Tags</Label>
              <div className="flex gap-2">
                <Input
                  value={tagInput}
                  onChange={(e) => setTagInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') { e.preventDefault(); addTag(); }
                  }}
                  placeholder="Add tag and press Enter"
                  className="border-[rgba(232,131,58,0.15)] bg-mil-bg-deep text-mil-fg placeholder:text-mil-dim rounded-none"
                  style={{ fontFamily: "var(--font-mono)" }}
                />
                <Button type="button" variant="command" onClick={addTag}>
                  Add
                </Button>
              </div>
              {form.tags.length > 0 && (
                <div className="flex flex-wrap gap-1.5 pt-1">
                  {form.tags.map((tag) => (
                    <span
                      key={tag}
                      className="inline-flex items-center gap-1 border border-[rgba(232,131,58,0.2)] bg-[rgba(232,131,58,0.06)] px-2 py-0.5 text-xs text-brand-light"
                      style={{ fontFamily: "var(--font-mono)" }}
                    >
                      {tag}
                      <button aria-label={`Remove ${tag} tag`}
                        type="button"
                        onClick={() => removeTag(tag)}
                        className="ml-0.5 hover:text-brand"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </span>
                  ))}
                </div>
              )}
            </div>

            {/* Create error */}
            {createError && (
              <div role="alert" className="border border-red-500/30 bg-red-500/8 px-3 py-2 text-sm text-red-200" style={{ fontFamily: "var(--font-mono)" }}>
                {createError}
              </div>
            )}
          </div>

          <DialogFooter className="shrink-0">
            <button
              type="button"
              onClick={() => setShowCreateModal(false)}
              className="min-h-11 px-4 py-2 text-xs font-bold text-mil-muted hover:text-mil-fg transition-colors"
              style={{ fontFamily: "var(--font-condensed)" }}
            >
              Cancel
            </button>
            <Button
              type="button"
              variant="commandPrimary"
              onClick={handleCreate}
              disabled={creating || !form.name.trim()}
            >
              {creating ? <RefreshCw className="animate-spin" aria-hidden="true" /> : <Save aria-hidden="true" />}
              {creating ? 'Creating...' : 'Create And Open'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export default ServerDashboard;
