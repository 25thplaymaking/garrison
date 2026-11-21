import React, { useState, useEffect, useCallback, useRef, Suspense } from 'react';
import { useParams, useNavigate, useLocation, useNavigationType, Outlet, Link } from 'react-router';
import { motion } from 'framer-motion';
import apiClient from '@/lib/apiClient';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  AlertOctagon,
  AlertTriangle,
  ArrowLeft,
  Bell,
  CalendarClock,
  Check,
  CheckCircle,
  ChevronLeft,
  ChevronRight,
  Circle,
  ClipboardList,
  FileCode2,
  FileText,
  Info,
  Layers,
  Loader2,
  Pencil,
  Puzzle,
  RefreshCw,
  RotateCcw,
  Server,
  Settings,
  ShieldCheck,
  Stethoscope,
  Square,
  Play,
  Terminal,
  Trash2,
  Users,
  Wrench,
  X,
} from 'lucide-react';
import { useAuth } from '@/context/AuthContext';
import { UnsavedChangesProvider, useUnsavedChanges } from '@/context/UnsavedChangesContext';
import { Button } from '@/components/ui/button';
import { ConfirmActionDialog } from '@/components/tactical/CommandUI';
import { hasPermission, PERMISSIONS } from '@/utils/permissions';
import {
  canRestartServer,
  canStartServer,
  canStopServer,
  currentFailureMessage,
  getOperationalSummary,
  isServerDegraded,
  normalizeServer,
} from '@/utils/serverStatus';
import { formatApiError } from '@/utils/errorMessages';

const SUMMARY_REFRESH_MS = 15_000;

// Same colour language as the fleet's server cards: gold for up, amber for
// in-between states, red for failures, grey for off. Failures used to share the
// gold of a healthy server, so an errored server read as online at a glance.
const TRANSITION_CLS = 'border-amber-500/35 bg-amber-500/10 text-amber-300';
const FAILURE_CLS = 'border-red-500/35 bg-red-500/10 text-red-300';
const STATUS_CONFIG = {
  running: { label: 'Online', cls: 'border-[rgba(232,131,58,0.32)] bg-[rgba(232,131,58,0.09)] text-brand-light', dotCls: 'status-dot status-dot-online', icon: CheckCircle },
  degraded: { label: 'Degraded', cls: TRANSITION_CLS, dotCls: 'status-dot status-dot-degraded', icon: AlertTriangle },
  starting: { label: 'Starting', cls: TRANSITION_CLS, dotCls: 'status-dot status-dot-degraded', icon: Loader2, spin: true },
  initializing: { label: 'Initializing', cls: TRANSITION_CLS, dotCls: 'status-dot status-dot-degraded', icon: Loader2, spin: true },
  stopping: { label: 'Stopping', cls: TRANSITION_CLS, dotCls: 'status-dot status-dot-degraded', icon: Loader2, spin: true },
  stopped: { label: 'Offline', cls: 'border-[#7d7d7d]/40 bg-[#7d7d7d]/10 text-mil-muted', dotCls: 'status-dot status-dot-offline', icon: Circle },
  created: { label: 'Created', cls: 'border-[#7d7d7d]/40 bg-[#7d7d7d]/10 text-mil-muted', dotCls: 'status-dot status-dot-offline', icon: Info },
  error: { label: 'Error', cls: FAILURE_CLS, dotCls: 'status-dot status-dot-critical', icon: AlertTriangle },
  deletion_pending: { label: 'Deleting', cls: TRANSITION_CLS, dotCls: 'status-dot status-dot-degraded', icon: Loader2, spin: true },
  crash_loop: { label: 'Crash loop', cls: FAILURE_CLS, dotCls: 'status-dot status-dot-critical', icon: AlertOctagon },
};

// Labelled controls in the fleet card style: gold start, red stop, neutral
// restart. Icon-only squares made stop and start indistinguishable.
const ACTION_BUTTON = 'inline-flex h-11 items-center gap-1.5 border px-3 text-xs font-semibold transition-colors disabled:opacity-40 sm:h-9';
const ACTION_STYLES = {
  start: 'border-[rgba(232,131,58,0.4)] text-brand-light hover:bg-brand/10',
  stop: 'border-red-700/40 text-red-300 hover:bg-red-600/10 hover:text-red-200',
  restart: 'border-white/10 text-mil-soft hover:border-[rgba(232,131,58,0.35)] hover:text-brand-light',
};

const NAV_SECTIONS = [
  {
    label: 'OPERATIONS',
    items: [
      { to: '', label: 'Overview', icon: Server, end: true },
      { to: 'console', label: 'Live Control', icon: Terminal, aliases: ['console', 'rcon'] },
      { to: 'players', label: 'Players & Metrics', icon: Users, aliases: ['players', 'metrics'] },
      { to: 'mods', label: 'Mods', icon: Puzzle, aliases: ['mods', 'tools/compare'] },
    ],
  },
  {
    label: 'CONFIGURATION',
    items: [
      { to: 'config/server', label: 'Server Config', icon: Settings, aliases: ['config/server', 'config/admin-tools'] },
      { to: 'config/health', label: 'Config Health', icon: ShieldCheck },
      { to: 'config/system', label: 'Infrastructure', icon: Settings },
      { to: 'schedules', label: 'Automation', icon: CalendarClock },
    ],
  },
  {
    label: 'FILES & DATA',
    items: [
      { to: 'tools/files', label: 'Files', icon: Wrench },
      { to: 'tools/reports', label: 'Reports', icon: FileText },
    ],
  },
  {
    label: 'MONITORING',
    items: [
      { to: 'diagnosis', label: 'Crash Analysis', icon: Stethoscope },
      { to: 'script-budget', label: 'Script Budget', icon: FileCode2 },
      // Incidents live under Health & Alerts (same failures as notifications).
      { to: 'tools/watchers?tab=incidents', label: 'Health & Alerts', icon: Bell, aliases: ['tools/watchers', 'admin/notifications', 'admin/incidents'] },
    ],
  },
  {
    label: 'ADMIN',
    items: [
      { to: 'admin/notes', label: 'Ops Log', icon: ClipboardList, aliases: ['admin/notes', 'tools/todos'] },
      // Integrations are fleet-wide, so they live on the fleet page's
      // Integrations tab.
    ],
  },
];

function mergeServerSummary(existing, summary) {
  return normalizeServer({
    ...(existing || {}),
    ...(summary || {}),
  });
}

function UnsavedChangesDialog() {
  const {
    pendingNavigation,
    saving,
    closePendingNavigation,
    leaveNow,
    saveAndLeave,
  } = useUnsavedChanges();
  const dirtySources = pendingNavigation?.dirtySources || [];
  const canSave = dirtySources.some((source) => typeof source.onSave === 'function');

  return (
    <Dialog open={Boolean(pendingNavigation)} onOpenChange={(open) => { if (!open) closePendingNavigation(); }}>
      <DialogContent className="w-[95vw] max-w-lg border-[rgba(255,170,0,0.35)] bg-mil-bg-panel text-mil-fg rounded-none">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-[#ffaa00]" style={{ fontFamily: "var(--font-heading)" }}>
            <AlertTriangle className="h-5 w-5" />
            Unsaved Changes
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <p className="text-sm text-mil-muted" style={{ fontFamily: "var(--font-body)" }}>
            Leaving this server-management module will discard local work that has not been deployed or saved.
          </p>
          {dirtySources.length > 0 && (
            <div className="rounded border border-[rgba(255,170,0,0.2)] bg-[rgba(255,170,0,0.06)] p-3">
              <p className="mb-2 text-xs font-medium text-[#ffaa00]">
                Pending work
              </p>
              <ul className="space-y-1 text-xs text-mil-fg" style={{ fontFamily: "var(--font-body)" }}>
                {dirtySources.map((source) => (
                  <li key={source.id} className="flex items-center gap-2">
                    <span className="h-1.5 w-1.5 rounded-full bg-[#ffaa00]" />
                    {source.label}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <p className="text-xs text-mil-dim" style={{ fontFamily: "var(--font-mono)" }}>
            Browser refreshes and tab closes use the native browser warning because custom unload dialogs are restricted.
          </p>
        </div>
        <div className="flex flex-wrap justify-end gap-2 pt-3">
          <Button type="button" variant="commandOutline" onClick={closePendingNavigation} disabled={saving}>
            Stay
          </Button>
          <Button type="button" variant="commandDanger" onClick={leaveNow} disabled={saving}>
            Leave without saving
          </Button>
          {canSave && (
            <Button type="button" variant="commandPrimary" onClick={saveAndLeave} disabled={saving}>
              {saving ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Check aria-hidden="true" />}
              Save and leave
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Phone tab rail: tracks whether there is more rail past either edge (for the
 * edge fades) and keeps the active tab in view on load and on every change,
 * so a deep-linked tab is never hidden off-screen. Scrolls the rail only,
 * never the page.
 */
export function useScrollRail(activeKey) {
  // A callback ref (state), not useRef: the rail mounts only after the server
  // loads, so effects must re-run when the element appears.
  const [rail, railRef] = useState(null);
  const [railEdges, setRailEdges] = useState({ start: false, end: false });
  const positionedRef = useRef(false);

  const measure = useCallback(() => {
    if (!rail) return;
    const max = rail.scrollWidth - rail.clientWidth;
    const next = { start: rail.scrollLeft > 4, end: max > 4 && rail.scrollLeft < max - 4 };
    setRailEdges((prev) => (prev.start === next.start && prev.end === next.end ? prev : next));
  }, [rail]);

  useEffect(() => {
    if (!rail) return undefined;
    measure();
    rail.addEventListener('scroll', measure, { passive: true });
    window.addEventListener('resize', measure);
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null;
    observer?.observe(rail);
    return () => {
      rail.removeEventListener('scroll', measure);
      window.removeEventListener('resize', measure);
      observer?.disconnect();
    };
  }, [rail, measure]);

  useEffect(() => {
    if (!rail) return;
    const active = rail.querySelector('[aria-current="page"]');
    if (active) {
      const railBox = rail.getBoundingClientRect();
      const tabBox = active.getBoundingClientRect();
      const offset = (tabBox.left + tabBox.width / 2) - (railBox.left + railBox.width / 2);
      const reduceMotion = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      if (Math.abs(offset) > 1 && typeof rail.scrollBy === 'function') {
        // Jump on first positioning (a deep link), glide on later tab changes.
        rail.scrollBy({ left: offset, behavior: reduceMotion || !positionedRef.current ? 'auto' : 'smooth' });
      }
      positionedRef.current = true;
    }
    measure();
  }, [rail, activeKey, measure]);

  return { railRef, railEdges };
}

function ServerWorkspaceContent() {
  const { id } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const { railRef, railEdges } = useScrollRail(location.pathname);
  const navigationType = useNavigationType();
  const { user } = useAuth();
  const {
    dirtySources,
    hasUnsavedChanges,
    confirmNavigation,
    saveAll,
    saving: savingAll,
  } = useUnsavedChanges();
  const canManage = user && hasPermission(user.role, PERMISSIONS.MANAGE_SERVERS);

  const [server, setServer] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [actionLoading, setActionLoading] = useState(null);
  const [actionError, setActionError] = useState(null);
  const [manualRefreshing, setManualRefreshing] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [scenarioRefreshTrigger, setScenarioRefreshTrigger] = useState(0);
  const [editingName, setEditingName] = useState(false);
  const [nameInput, setNameInput] = useState('');
  const [nameSaving, setNameSaving] = useState(false);
  const bumpScenarioRefresh = useCallback(() => setScenarioRefreshTrigger((n) => n + 1), []);
  const fullRequestEpochRef = useRef(0);
  const fullSettledEpochRef = useRef(0);
  const summaryRequestEpochRef = useRef(0);

  const fetchServer = useCallback(async (silent = false) => {
    const requestEpoch = ++fullRequestEpochRef.current;
    if (!silent) setLoading(true);
    try {
      const res = await apiClient.get(`/servers/${id}`);
      if (requestEpoch !== fullRequestEpochRef.current) return;
      fullSettledEpochRef.current = requestEpoch;
      setServer(normalizeServer(res.data));
      setError(null);
    } catch (err) {
      if (requestEpoch !== fullRequestEpochRef.current) return;
      fullSettledEpochRef.current = requestEpoch;
      if (err.response?.status === 404) {
        setServer(null);
        setError('Server not found.');
        return;
      }
      if (!silent) {
        setError(formatApiError(err, 'Failed to load server.'));
      }
    } finally {
      if (requestEpoch === fullRequestEpochRef.current) setLoading(false);
    }
  }, [id]);

  const serverRef = useRef(null);
  const nameInputRef = useRef(null);
  const lastLocationRef = useRef(location);
  const bypassNextLocationRef = useRef(false);
  useEffect(() => {
    serverRef.current = server;
  }, [server]);

  useEffect(() => {
    const handleBeforeUnload = (event) => {
      if (!hasUnsavedChanges) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [hasUnsavedChanges]);

  useEffect(() => {
    const currentKey = `${location.pathname}${location.search}${location.hash}`;
    const previous = lastLocationRef.current;
    const previousKey = `${previous.pathname}${previous.search}${previous.hash}`;

    if (bypassNextLocationRef.current) {
      bypassNextLocationRef.current = false;
      lastLocationRef.current = location;
      return;
    }

    if (navigationType === 'POP' && hasUnsavedChanges && currentKey !== previousKey) {
      const target = location;
      bypassNextLocationRef.current = true;
      navigate(`${previous.pathname}${previous.search}${previous.hash}`, { replace: true });
      confirmNavigation(() => {
        bypassNextLocationRef.current = true;
        navigate(`${target.pathname}${target.search}${target.hash}`);
      });
      return;
    }

    lastLocationRef.current = location;
  }, [confirmNavigation, hasUnsavedChanges, location, navigate, navigationType]);

  const handleWorkspaceClickCapture = useCallback((event) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.altKey || event.ctrlKey || event.shiftKey) return;
    const anchor = event.target.closest?.('a[href]');
    if (!anchor) return;
    if (anchor.target && anchor.target !== '_self') return;
    if (anchor.hasAttribute('download')) return;

    const href = anchor.getAttribute('href');
    if (!href || href.startsWith('#')) return;

    const nextUrl = new URL(anchor.href, window.location.href);
    if (nextUrl.origin !== window.location.origin) return;

    const nextPath = `${nextUrl.pathname}${nextUrl.search}${nextUrl.hash}`;
    const currentPath = `${location.pathname}${location.search}${location.hash}`;
    if (nextPath === currentPath) return;

    event.preventDefault();
    confirmNavigation(() => {
      bypassNextLocationRef.current = true;
      navigate(nextPath);
    });
  }, [confirmNavigation, location.hash, location.pathname, location.search, navigate]);

  const fetchServerSummary = useCallback(async () => {
    const requestEpoch = ++summaryRequestEpochRef.current;
    const fullEpochAtStart = fullRequestEpochRef.current;
    const fullSettledEpochAtStart = fullSettledEpochRef.current;
    try {
      const res = await apiClient.get(`/servers/${id}/summary`);
      if (
        requestEpoch !== summaryRequestEpochRef.current
        || fullEpochAtStart !== fullRequestEpochRef.current
        || fullSettledEpochAtStart !== fullEpochAtStart
        || fullEpochAtStart !== fullSettledEpochRef.current
      ) return;
      setServer((current) => mergeServerSummary(current, res.data));
      setError(null);
    } catch (err) {
      if (
        requestEpoch !== summaryRequestEpochRef.current
        || fullEpochAtStart !== fullRequestEpochRef.current
        || fullSettledEpochAtStart !== fullEpochAtStart
        || fullEpochAtStart !== fullSettledEpochRef.current
      ) return;
      if (!serverRef.current) {
        setError(formatApiError(err, 'Failed to load server summary.'));
      }
    }
  }, [id]);

  useEffect(() => {
    fetchServer();
  }, [fetchServer]);

  const handleManualRefresh = useCallback(async () => {
    setManualRefreshing(true);
    try {
      await fetchServer(true);
    } finally {
      setManualRefreshing(false);
    }
  }, [fetchServer]);

  useEffect(() => {
    const intervalId = setInterval(fetchServerSummary, SUMMARY_REFRESH_MS);
    return () => clearInterval(intervalId);
  }, [fetchServerSummary]);

  const handleAction = useCallback(async (action) => {
    setActionLoading(action);
    setActionError(null);
    try {
      await apiClient.post(`/servers/${id}/${action}`);
      await fetchServer(true);
    } catch (err) {
      setActionError(formatApiError(err, `Failed to ${action} server.`));
      await fetchServer(true);
    } finally {
      setActionLoading(null);
    }
  }, [fetchServer, id]);

  const handleDelete = useCallback(async () => {
    setDeleting(true);
    try {
      await apiClient.delete(`/servers/${id}`);
      navigate('/servers', { replace: true });
    } catch (err) {
      setActionError(formatApiError(err, 'Failed to delete server.'));
      setDeleting(false);
      setDeleteOpen(false);
    }
  }, [id, navigate]);

  const startEditingName = useCallback(() => {
    setNameInput(server?.name || '');
    setEditingName(true);
    setTimeout(() => nameInputRef.current?.select(), 50);
  }, [server]);

  const cancelEditingName = useCallback(() => {
    setEditingName(false);
    setNameInput(server?.name || '');
  }, [server]);

  const saveDisplayName = useCallback(async () => {
    const trimmed = nameInput.trim();
    if (!trimmed) {
      setActionError('Display name cannot be empty.');
      return;
    }
    if (trimmed === server?.name) {
      cancelEditingName();
      return;
    }

    setNameSaving(true);
    try {
      await apiClient.put(`/servers/${id}`, { name: trimmed });
      await fetchServer(true);
      setEditingName(false);
    } catch (err) {
      setActionError(formatApiError(err, 'Failed to rename display name.'));
    } finally {
      setNameSaving(false);
    }
  }, [cancelEditingName, fetchServer, id, nameInput, server]);

  const status = server?.status || 'created';
  const summary = getOperationalSummary(server);
  const effectiveStatus = status === 'running' && isServerDegraded(server) ? 'degraded' : status;
  const cfg = STATUS_CONFIG[effectiveStatus] || STATUS_CONFIG.created;
  const StatusIcon = cfg.icon;
  const canStart = canStartServer(server);
  const canStop = canStopServer(server);
  const canRestart = canRestartServer(server);
  const dirtySourceCount = dirtySources.length;
  const showProvisioningBanner = summary.state === 'created'
    || summary.state === 'degraded'
    || status === 'error'
    || status === 'deletion_pending';
  // A server that has run before and then failed a start/stop/restart is not a
  // creation failure, and its all-green provisioning stages from that first
  // build say nothing about the current error.
  const hasFailedStage = Object.values(server?.provisioning_stages || {}).some((stage) => stage?.status === 'failed');
  const isCreationFailure = status === 'error' && (hasFailedStage || !(server?.last_started || server?.last_stopped));
  const showStageGrid = status !== 'error' || isCreationFailure;
  const bannerMessage = currentFailureMessage(server);
  const baseWorkspacePath = `/servers/${id}`;
  const isNavItemActive = useCallback((item) => {
    const relativePaths = item.aliases || [item.to];
    if (item.end) return location.pathname === baseWorkspacePath;
    return relativePaths.some((relativePath) => location.pathname === `${baseWorkspacePath}/${relativePath}`);
  }, [baseWorkspacePath, location.pathname]);

  if (loading) {
    return (
      <div className="flex h-[60vh] items-center justify-center" role="status" aria-label="Loading server workspace">
        <Loader2 className="h-8 w-8 animate-spin text-brand-light" />
        <span className="sr-only">Loading server workspace</span>
      </div>
    );
  }

  if (error || !server) {
    return (
      <div className="flex h-[60vh] flex-col items-center justify-center gap-4" role="alert">
        <AlertTriangle className="h-12 w-12 text-brand" />
        <p className="text-lg text-brand" style={{ fontFamily: "var(--font-mono)" }}>{error || 'Server not found'}</p>
        <Button asChild variant="command">
          <Link to="/servers">
            <ArrowLeft aria-hidden="true" /> Back to Servers
          </Link>
        </Button>
      </div>
    );
  }

  return (
    <div className="flex min-h-[calc(100dvh-4rem)] flex-col bg-mil-bg-deep" onClickCapture={handleWorkspaceClickCapture}>
      <div className="border-b border-[rgba(232,131,58,0.12)] bg-mil-bg-panel px-4 py-3 lg:px-6">
        <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
          <div className="flex min-w-0 items-start gap-3">
            <Link to="/servers" className="flex h-11 w-11 shrink-0 items-center justify-center border border-[rgba(232,131,58,0.12)] text-mil-muted transition-colors hover:border-[rgba(232,131,58,0.32)] hover:text-brand-light" aria-label="Back to server dashboard">
              <ArrowLeft className="h-5 w-5" />
            </Link>
            <div className="flex min-w-0 items-center gap-3">
              <div className="min-w-0">
                {editingName ? (
                  <div className="space-y-2">
                    <div className="flex max-w-full items-center gap-2">
                      <input
                        ref={nameInputRef}
                        type="text"
                        value={nameInput}
                        onChange={(e) => setNameInput(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            saveDisplayName();
                          }
                          if (e.key === 'Escape') {
                            e.preventDefault();
                            cancelEditingName();
                          }
                        }}
                        className="h-11 w-full max-w-xl rounded border border-[rgba(232,131,58,0.25)] bg-mil-bg-deep/80 px-3 py-1.5 text-sm font-black text-brand-light outline-hidden focus:border-brand-light"
                        style={{ fontFamily: "var(--font-heading)" }}
                        placeholder="Display name"
                      />
                      <button
                        type="button"
                        onClick={saveDisplayName}
                        disabled={nameSaving}
                        className="flex h-11 w-11 shrink-0 items-center justify-center text-brand-light transition-colors hover:text-[#ff706f] disabled:opacity-50"
                        aria-label="Save server display name"
                      >
                        {nameSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                      </button>
                      <button aria-label="Cancel server rename"
                        type="button"
                        onClick={cancelEditingName}
                        disabled={nameSaving}
                        className="flex h-11 w-11 shrink-0 items-center justify-center text-mil-muted transition-colors hover:text-mil-fg disabled:opacity-50"
                      >
                        <X className="h-4 w-4" />
                      </button>
                    </div>
                    <p className="text-xs text-mil-muted font-medium">
                      Display name shown in the yellow header and server cards
                    </p>
                  </div>
                ) : (
                  <div className="flex min-w-0 items-center gap-2">
                    <h1 className="min-w-0 break-words text-lg font-semibold leading-tight text-mil-bright sm:text-xl" style={{ fontFamily: "var(--font-heading)" }}>
                      {server.name}
                    </h1>
                    {canManage && (
                      <button aria-label={`Rename ${server.name}`}
                        type="button"
                        onClick={startEditingName}
                        className="flex h-11 w-11 shrink-0 items-center justify-center text-mil-muted transition-colors hover:text-brand-light"
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                )}
                <details className="mt-1 max-w-2xl text-xs text-mil-dim" style={{ fontFamily: "var(--font-mono)" }}>
                  <summary className="flex min-h-11 w-fit cursor-pointer items-center text-mil-muted transition-colors hover:text-brand-light focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-brand/60">
                    Technical details
                  </summary>
                  <dl className="grid gap-1 border-l border-[rgba(232,131,58,0.14)] pl-3 pb-1">
                    <div className="grid min-w-0 gap-1 sm:grid-cols-[7rem_1fr]">
                      <dt>Server ID</dt>
                      <dd className="wrap-break-word min-w-0 text-mil-muted">{server.id}</dd>
                    </div>
                    <div className="grid min-w-0 gap-1 sm:grid-cols-[7rem_1fr]">
                      <dt>Runtime image</dt>
                      <dd className="wrap-break-word min-w-0 text-mil-muted">{server.docker_image || 'Managed container'}</dd>
                    </div>
                    {server.container_name && (
                      <div className="grid min-w-0 gap-1 sm:grid-cols-[7rem_1fr]">
                        <dt>Container</dt>
                        <dd className="wrap-break-word min-w-0 text-mil-muted">{server.container_name}</dd>
                      </div>
                    )}
                  </dl>
                </details>
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <span className={`inline-flex h-9 items-center gap-1.5 border px-3 text-xs font-semibold ${cfg.cls}`} style={{ fontFamily: "var(--font-condensed)" }}>
              <span className={cfg.dotCls} />
              <StatusIcon className={`h-3.5 w-3.5 ${cfg.spin ? 'animate-spin' : ''}`} />
              {cfg.label}
            </span>

            {dirtySourceCount > 0 && (
              <button
                type="button"
                onClick={() => { saveAll().then((ok) => { if (ok) fetchServer(true); }); }}
                disabled={savingAll}
                className="inline-flex min-h-11 items-center gap-1.5 border border-[rgba(232,131,58,0.28)] bg-mil-bg-deep/80 px-3 text-[13px] font-medium text-brand transition-colors hover:bg-[rgba(232,131,58,0.08)]"
                style={{ fontFamily: "var(--font-condensed)" }}
              >
                {savingAll ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Layers className="h-3.5 w-3.5" />}
                Save all pending changes ({dirtySourceCount})
              </button>
            )}

            <div className="flex items-center gap-1.5">
              {[
                ['start', canStart, Play, 'Start', 'Starting'],
                ['stop', canStop, Square, 'Stop', 'Stopping'],
                ['restart', canRestart, RotateCcw, 'Restart', 'Restarting'],
              ].filter(([, allowed]) => allowed).map(([action, , Icon, label, busyLabel]) => (
                <button
                  key={action}
                  type="button"
                  disabled={!!actionLoading}
                  onClick={() => handleAction(action)}
                  className={`${ACTION_BUTTON} ${ACTION_STYLES[action]}`}
                  style={{ fontFamily: "var(--font-condensed)" }}
                  aria-label={`${label} server`}
                >
                  {actionLoading === action ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Icon className="h-3.5 w-3.5" />}
                  {actionLoading === action ? busyLabel : label}
                </button>
              ))}
              <button
                type="button"
                onClick={handleManualRefresh}
                disabled={manualRefreshing}
                className="flex h-11 w-11 items-center justify-center border border-transparent text-mil-muted transition-colors hover:border-[rgba(232,131,58,0.16)] hover:text-brand-light disabled:cursor-wait disabled:opacity-50 sm:h-9 sm:w-9"
                aria-label="Refresh server"
                title="Refresh"
              >
                <RefreshCw className={`h-3.5 w-3.5 ${manualRefreshing ? 'animate-spin' : ''}`} />
              </button>
              {canManage && (
                <button
                  type="button"
                  onClick={() => setDeleteOpen(true)}
                  className="flex h-11 w-11 items-center justify-center border border-transparent text-mil-muted transition-colors hover:border-red-700/40 hover:text-red-300 sm:h-9 sm:w-9"
                  aria-label="Delete server"
                  title="Delete server"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          </div>
        </div>

        {actionError && (
          <div role="alert" className="mt-2 flex items-center gap-2 border border-red-500/30 bg-red-500/8 px-3 py-2 text-xs text-red-200" style={{ fontFamily: "var(--font-mono)" }}>
            <AlertTriangle className="h-4 w-4 shrink-0" />
            <span>{actionError}</span>
            <button type="button" aria-label="Dismiss server action error" onClick={() => setActionError(null)} className="ml-auto min-h-11 px-2 text-red-200 hover:text-white">
              close
            </button>
          </div>
        )}

        {showProvisioningBanner && (
          <div className={`mt-3 border px-4 py-3 text-xs ${
            summary.state === 'created'
              ? 'border-[rgba(232,131,58,0.3)] bg-[rgba(232,131,58,0.06)] text-mil-muted'
              : summary.state === 'degraded'
                ? 'border-amber-500/30 bg-amber-500/[0.06] text-amber-300'
                : 'border-red-500/30 bg-red-500/[0.07] text-red-200'
          }`} style={{ fontFamily: "var(--font-mono)" }}>
            <div className="mb-2 flex items-center gap-2 font-semibold capitalize">
              {summary.state === 'created'
                ? <Info className="h-3.5 w-3.5 shrink-0" />
                : <AlertTriangle className="h-3.5 w-3.5 shrink-0" />}
              {server.needs_manual_intervention
                ? 'Auto-recovery exhausted - manual config correction required'
                : summary.state === 'deletion_pending'
                  ? 'Server deletion is blocked. Resolve the reported cleanup error and retry deletion.'
                  : summary.state === 'created'
                    ? 'Server deployed successfully. Follow-up provisioning is continuing here.'
                    : summary.state === 'degraded'
                      ? 'Server created successfully, but follow-up stages need attention'
                      : isCreationFailure
                        ? 'Server creation failed before the container became operational'
                        : 'Server is in an error state - the last start, stop, or restart did not complete'}
            </div>
            {server.needs_manual_intervention && server.auto_recovery_attempts > 0 && (
              <p className="mb-1 text-amber-300">
                The system attempted {server.auto_recovery_attempts} automatic fix(es) but could not resolve the config error.
                Please review the server settings and correct the configuration manually.
              </p>
            )}
            {bannerMessage && (
              <p className="mb-1 wrap-break-word text-mil-muted">{bannerMessage}</p>
            )}
            {['error', 'crash_loop'].includes(server.status) && (
              <Link
                to={`/servers/${server.id}/diagnosis`}
                className="mb-1 inline-flex items-center gap-1.5 text-xs font-medium text-brand-light underline-offset-2 hover:underline"
              >
                <Stethoscope className="h-3.5 w-3.5" /> Open crash analysis and suggested fixes
              </Link>
            )}
            {showStageGrid && server.provisioning_stages && Object.keys(server.provisioning_stages).length > 0 && (
              <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                {Object.values(server.provisioning_stages).map((stage) => (
                  <div key={stage.name} className="flex items-start gap-2 border border-current/10 bg-mil-bg-deep/35 px-2.5 py-2">
                    {stage.status === 'success' ? (
                      <CheckCircle className="h-3 w-3 text-brand-light" />
                    ) : stage.status === 'failed' ? (
                      <AlertTriangle className="h-3 w-3 text-brand" />
                    ) : (
                      <Circle className="h-3 w-3 text-mil-dim" />
                    )}
                    <div className="min-w-0">
                      <span className={
                        stage.status === 'success' ? 'text-brand-light' :
                        stage.status === 'failed' ? 'text-brand' :
                        'text-mil-dim'
                      }>
                        {stage.name.replace(/_/g, ' ')}
                      </span>
                      {stage.error && (
                        <span className="mt-1 block wrap-break-word text-mil-muted">{stage.error}</span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {status === 'running' && server.provisioning_warnings?.length > 0 && (
          <div className="mt-2 border border-[rgba(255,170,0,0.2)] bg-[rgba(255,170,0,0.04)] px-3 py-2 text-xs text-[#ffaa00]/80" style={{ fontFamily: "var(--font-mono)" }}>
            <div className="mb-1 flex items-center gap-2 font-semibold">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
              Server is running with non-critical provisioning warnings
            </div>
            <div className="space-y-0.5">
              {server.provisioning_warnings.map((warning, index) => (
                <p key={index} className="text-mil-muted">
                  <span className="text-[#ffaa00]/60">{warning.stage?.replace(/_/g, ' ')}:</span> {warning.message}
                </p>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* No overflow clipping here: the page scrolls as one, which keeps the
          desktop sidebar sticky and its Collapse control in reach. */}
      <div className="flex flex-1 flex-col lg:flex-row">
        <nav id="server-workspace-navigation" aria-label="Server workspace" className={`hidden shrink-0 flex-col border-r border-[rgba(232,131,58,0.12)] bg-mil-bg-deep transition-all lg:sticky lg:top-[var(--shell-nav-offset)] lg:flex lg:max-h-[calc(100dvh-var(--shell-nav-offset))] lg:self-start ${sidebarCollapsed ? 'w-14' : 'w-52'}`}>
          <div className="flex-1 overflow-y-auto px-2 py-3">
            {NAV_SECTIONS.map((section) => (
              <div key={section.label} className="mb-3">
                {!sidebarCollapsed && (
                  <div className="px-2 py-1.5 text-[11px] font-semibold text-mil-dim capitalize" style={{ fontFamily: "var(--font-condensed)" }}>
                    {section.label}
                  </div>
                )}
                {section.items.map((item) => {
                  const Icon = item.icon;
                  const isActive = isNavItemActive(item);
                  return (
                    <Link
                      key={item.to}
                      to={item.to}
                      aria-current={isActive ? 'page' : undefined}
                      aria-label={sidebarCollapsed ? item.label : undefined}
                      title={sidebarCollapsed ? item.label : undefined}
                      className={
                        `group mb-0.5 flex min-h-9 items-center gap-2.5 border-l-2 px-2.5 py-1.5 text-sm transition-colors ${
                          isActive
                            ? 'border-brand-light bg-[rgba(232,131,58,0.08)] text-brand-light'
                            : 'border-transparent text-mil-muted hover:bg-mil-bg-elevated/70 hover:text-mil-fg'
                        } ${sidebarCollapsed ? 'justify-center px-0' : ''}`
                      }
                      style={{ fontFamily: "var(--font-body)" }}
                    >
                      <Icon className={`h-4 w-4 shrink-0 ${isActive ? 'text-brand-light' : 'text-mil-dim group-hover:text-mil-fg'}`} aria-hidden="true" />
                      {!sidebarCollapsed && <span className="truncate">{item.label}</span>}
                    </Link>
                  );
                })}
              </div>
            ))}
          </div>
          <button
            type="button"
            onClick={() => setSidebarCollapsed((prev) => !prev)}
            aria-controls="server-workspace-navigation"
            aria-expanded={!sidebarCollapsed}
            aria-label={sidebarCollapsed ? 'Expand server workspace navigation' : 'Collapse server workspace navigation'}
            className="flex min-h-11 items-center justify-center gap-2 border-t border-[rgba(232,131,58,0.12)] bg-mil-bg-panel/75 px-3 py-2 text-xs text-mil-muted transition-colors hover:text-brand-light"
            style={{ fontFamily: "var(--font-mono)" }}
          >
            {sidebarCollapsed ? <ChevronRight className="h-4 w-4" aria-hidden="true" /> : <><ChevronLeft className="h-4 w-4" aria-hidden="true" /> Collapse</>}
          </button>
        </nav>

        <div className="relative w-full shrink-0 lg:hidden">
        <nav ref={railRef} aria-label="Server workspace" className="flex w-full overflow-x-auto border-b border-[rgba(232,131,58,0.12)] bg-mil-bg-deep/96 px-2 [scrollbar-width:none]">
          {NAV_SECTIONS.flatMap((section) => section.items).map((item) => {
            const Icon = item.icon;
            const isActive = isNavItemActive(item);
            return (
              <Link
                key={item.to}
                to={item.to}
                aria-current={isActive ? 'page' : undefined}
                className={
                  `my-2 flex min-h-11 shrink-0 items-center gap-1.5 whitespace-nowrap border px-3 py-2 text-xs transition-colors ${
                    isActive
                      ? 'border-[rgba(232,131,58,0.35)] bg-[rgba(232,131,58,0.08)] text-brand-light'
                      : 'border-transparent text-mil-muted hover:border-[rgba(232,131,58,0.12)] hover:text-mil-fg'
                  }`
                }
                style={{ fontFamily: "var(--font-body)" }}
              >
                <Icon className="h-3.5 w-3.5" aria-hidden="true" />
                {item.label}
              </Link>
            );
          })}
        </nav>
        {/* Edge fades say "more this way" when the rail is wider than the phone. */}
        <span aria-hidden="true" data-testid="rail-fade-start" className={`pointer-events-none absolute inset-y-0 left-0 w-8 bg-linear-to-r from-mil-bg-deep to-transparent transition-opacity ${railEdges.start ? 'opacity-100' : 'opacity-0'}`} />
        <span aria-hidden="true" data-testid="rail-fade-end" className={`pointer-events-none absolute inset-y-0 right-0 w-8 bg-linear-to-l from-mil-bg-deep to-transparent transition-opacity ${railEdges.end ? 'opacity-100' : 'opacity-0'}`} />
        </div>

        <div className="min-w-0 flex-1 bg-mil-bg-deep p-3 sm:p-4 lg:p-6">
          <Suspense fallback={
            <div className="flex items-center justify-center gap-3 py-24 text-xs text-mil-muted" role="status">
              <Loader2 className="h-5 w-5 animate-spin text-brand-light" aria-hidden="true" />
              Loading module
            </div>
          }>
            <motion.div
              key={location.pathname}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.2, ease: [0.25, 0.46, 0.45, 0.94] }}
              className="min-w-0"
            >
              <Outlet context={{ server, serverId: id, fetchServer, canManage, user, handleServerAction: handleAction, actionLoading, scenarioRefreshTrigger, bumpScenarioRefresh }} />
            </motion.div>
          </Suspense>
        </div>
      </div>

      <ConfirmActionDialog
        open={deleteOpen}
        onOpenChange={(open) => { if (!deleting) setDeleteOpen(open); }}
        title="Delete server?"
        description={<>Delete <strong className="text-mil-fg">{server.name}</strong>? This cannot be undone.</>}
        confirmLabel="Delete server"
        destructive
        busy={deleting}
        onConfirm={handleDelete}
      />
      <UnsavedChangesDialog />
    </div>
  );
}

function ServerWorkspace() {
  return (
    <UnsavedChangesProvider>
      <ServerWorkspaceContent />
    </UnsavedChangesProvider>
  );
}

export default ServerWorkspace;
