import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useOutletContext, Link } from 'react-router';
import { useRealtimeTopic } from '@/hooks/useRealtime';
import apiClient from '@/lib/apiClient';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Activity,
  Clock,
  Users,
  Cpu,
  HardDrive,
  AlertTriangle,
  Puzzle,
  Settings,
  Network,
  Server,
  Loader2,
  CheckCircle,
  Play,
  Square,
  RotateCcw,
  ShieldAlert,
  Trash2,
  Lock,
  ChevronDown,
  ChevronRight,
  Eye,
  EyeOff,
  ShieldCheck,
  Stethoscope,
  FileText,
  StickyNote,
  X,
} from 'lucide-react';
import { canRestartServer, canStartServer, canStopServer, currentFailureMessage, isServerDegraded, normalizeServer } from '@/utils/serverStatus';
import { toast } from '@/hooks/use-toast';
import { formatApiError } from '@/utils/errorMessages';

/* ── Human-friendly severity helpers ──────────────────────────────────── */

const SEVERITY_CONFIG = {
  critical: { cls: 'border-red-600/30 bg-red-600/5', dot: 'bg-red-500', text: 'text-red-300' },
  high: { cls: 'border-orange-600/30 bg-orange-600/5', dot: 'bg-orange-500', text: 'text-orange-300' },
  medium: { cls: 'border-amber-600/30 bg-amber-600/5', dot: 'bg-amber-500', text: 'text-amber-300' },
  low: { cls: 'border-zinc-600/30 bg-zinc-600/5', dot: 'bg-zinc-500', text: 'text-zinc-400' },
};

/* ── Collapsible section ──────────────────────────────────────────────── */

function CollapsibleSection({ title, icon: Icon, count, open, onToggle, badge, children }) {
  const contentId = React.useId();
  return (
    <div className="border border-zinc-800/60 rounded bg-mil-bg-deep/40">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        aria-controls={contentId}
        className="flex min-h-11 w-full items-center gap-2 px-3 py-2 text-xs hover:bg-zinc-900/40 transition-colors"
      >
        {open ? <ChevronDown className="h-3 w-3 text-mil-dim" /> : <ChevronRight className="h-3 w-3 text-mil-dim" />}
        {Icon && <Icon className="h-3.5 w-3.5 text-brand" />}
        <span className="font-semibold tracking-wider text-mil-muted" style={{ fontFamily: "var(--font-heading)" }}>{title}</span>
        {count != null && count > 0 && (
          <Badge variant="outline" className="ml-1 border-zinc-700 text-[11px] text-mil-muted">{count}</Badge>
        )}
        {badge}
        <span className="ml-auto text-[11px] text-mil-dim">{open ? 'collapse' : 'expand'}</span>
      </button>
      {open && <div id={contentId} role="region" aria-label={title} className="border-t border-zinc-800/40 px-3 py-2">{children}</div>}
    </div>
  );
}

/* ── Evidence Viewer (log snapshot) ───────────────────────────────────── */

function EvidenceViewer({ snapshot, onClose }) {
  if (!snapshot || snapshot.length === 0) {
    return (
      <div className="rounded border border-zinc-800 bg-mil-bg-deep p-3 text-xs text-mil-dim">
        No log evidence captured for this event.
      </div>
    );
  }

  return (
    <div className="rounded border border-zinc-800 bg-mil-bg-deep overflow-hidden">
      <div className="flex items-center justify-between border-b border-zinc-800/60 px-3 py-1.5">
        <span className="text-[11px] font-semibold tracking-wider text-mil-dim">LOG EVIDENCE</span>
        {onClose && (
          <button aria-label="Close" type="button" onClick={onClose} className="text-mil-dim hover:text-mil-muted">
            <X className="h-3 w-3" />
          </button>
        )}
      </div>
      <div className="max-h-48 overflow-y-auto p-2 font-mono text-[11px] leading-relaxed">
        {snapshot.map((entry, idx) => (
          <div
            key={idx}
            className={`flex gap-2 px-1 py-0.5 rounded ${
              entry.is_trigger
                ? 'bg-amber-500/10 border-l-2 border-amber-500'
                : 'hover:bg-zinc-900/40'
            }`}
          >
            <span className="shrink-0 w-[60px] text-[11px] text-zinc-600 tabular-nums">
              {entry.timestamp ? new Date(entry.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : ''}
            </span>
            <span className="shrink-0 text-[11px] text-zinc-500 w-[50px] truncate">{entry.source || ''}</span>
            <span className={entry.is_trigger ? 'text-amber-200 font-medium' : 'text-mil-muted'}>
              {entry.line}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ── Single Diagnostic Item ───────────────────────────────────────────── */

function DiagnosticItem({ item, onMarkSafe, onReactivate, busy }) {
  const [expanded, setExpanded] = useState(false);
  const sev = SEVERITY_CONFIG[item.severity] || SEVERITY_CONFIG.medium;
  const isIgnored = item.status === 'ignored' || item.status === 'false_positive';

  return (
    <div className={`rounded border ${isIgnored ? 'border-zinc-800/40 opacity-60' : sev.cls} transition-all`}>
      <div className="flex items-start gap-2 px-3 py-2">
        <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${sev.dot}`} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs font-medium text-mil-fg">{item.title}</span>
            <Badge variant="outline" className="border-white/10 text-[11px] text-mil-muted capitalize">
              {item.severity}
            </Badge>
            {isIgnored && (
              <Badge variant="outline" className="border-zinc-700 text-[11px] text-zinc-500">
                safe / known
              </Badge>
            )}
          </div>
          {/* Human-friendly summary */}
          {item.human_summary && (
            <p className="mt-1 text-xs text-mil-muted leading-relaxed">{item.human_summary}</p>
          )}
          {!item.human_summary && item.summary && (
            <p className="mt-1 text-xs text-mil-muted">{item.summary}</p>
          )}
          {/* What this means + what to do */}
          {(item.human_impact || item.human_action) && (
            <div className="mt-1.5 space-y-1">
              {item.human_impact && (
                <div className="flex gap-1.5 text-[11px]">
                  <span className="shrink-0 font-semibold text-mil-dim">Impact:</span>
                  <span className="text-mil-muted">{item.human_impact}</span>
                </div>
              )}
              {item.human_action && (
                <div className="flex gap-1.5 text-[11px]">
                  <span className="shrink-0 font-semibold text-mil-dim">Action:</span>
                  <span className="text-mil-muted">{item.human_action}</span>
                </div>
              )}
            </div>
          )}
          {/* Recommended actions */}
          {!item.human_action && item.recommended_actions?.length > 0 && (
            <div className="mt-1.5 space-y-0.5">
              {item.recommended_actions.map((action, i) => (
                <div key={i} className="flex items-start gap-1.5 text-[11px] text-mil-dim">
                  <span className="mt-0.5">→</span>
                  <span>{action}</span>
                </div>
              ))}
            </div>
          )}
          {/* Meta row */}
          <div className="mt-1.5 flex items-center gap-3 text-[11px] text-mil-dim">
            {item.source_type && <span>{item.source_type}</span>}
            {item.last_seen && <span>{new Date(item.last_seen).toLocaleString()}</span>}
            {item.occurrence_count > 1 && <span>×{item.occurrence_count}</span>}
            {(item.log_snapshot?.length > 0 || item.evidence?.length > 0) && (
              <button
                type="button"
                onClick={() => setExpanded((v) => !v)}
                aria-expanded={expanded}
                className="flex min-h-11 items-center gap-1 px-2 text-brand hover:text-brand-light transition-colors"
              >
                <FileText className="h-3 w-3" />
                {expanded ? 'Hide evidence' : 'View evidence'}
              </button>
            )}
          </div>
        </div>
        {/* Actions */}
        <div className="shrink-0 flex items-center gap-1 pt-0.5">
          {!isIgnored ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => onMarkSafe?.(item.id)}
              disabled={busy}
              className="min-h-11 px-2 text-[11px] border-zinc-800 text-mil-muted hover:text-green-400 hover:border-green-600/30"
              title="Mark as safe / known issue"
            >
              <ShieldCheck className="h-3 w-3 mr-1" /> Safe
            </Button>
          ) : (
            <Button
              size="sm"
              variant="outline"
              onClick={() => onReactivate?.(item.id)}
              disabled={busy}
              className="min-h-11 px-2 text-[11px] border-zinc-800 text-mil-muted"
              title="Return to active diagnostics"
            >
              <Eye className="h-3 w-3 mr-1" /> Reactivate
            </Button>
          )}
        </div>
      </div>
      {/* Evidence viewer */}
      {expanded && (
        <div className="border-t border-zinc-800/40 px-3 py-2">
          <EvidenceViewer
            snapshot={item.log_snapshot?.length > 0 ? item.log_snapshot : null}
            onClose={() => setExpanded(false)}
          />
        </div>
      )}
    </div>
  );
}

function OverviewModule() {
  const { server: rawServer, serverId, fetchServer, handleServerAction, actionLoading, canManage, user } = useOutletContext();
  const server = normalizeServer(rawServer);
  const [metricsSummary, setMetricsSummary] = useState(null);
  const [incidents, setIncidents] = useState([]);
  const [detections, setDetections] = useState([]);
  const [loading, setLoading] = useState(true);
  const [resetting, setResetting] = useState(false);
  const [resetDialogOpen, setResetDialogOpen] = useState(false);
  const [runtimeDialogOpen, setRuntimeDialogOpen] = useState(false);
  const [showIgnored, setShowIgnored] = useState(false);
  const [verdictBusy, setVerdictBusy] = useState(false);
  const [refreshState, setRefreshState] = useState({ status: 'loading', checkedAt: null, failed: [] });
  const requestEpochRef = useRef(0);

  /* ── Collapsible state ──────────────────────────────────────────── */
  const [diagOpen, setDiagOpen] = useState(true);
  const [stagesOpen, setStagesOpen] = useState(false);
  const [ignoredOpen, setIgnoredOpen] = useState(false);

  const fetchOverviewData = useCallback(async () => {
    const requestEpoch = ++requestEpochRef.current;
    try {
      const [metricsRes, incidentsRes, detectionsRes] = await Promise.allSettled([
        apiClient.get(`/servers/${serverId}/metrics/summary`),
        apiClient.get(`/servers/${serverId}/incidents?status=open`),
        apiClient.get(`/servers/${serverId}/detections`, {
          params: { include_ignored: showIgnored },
        }),
      ]);
      if (requestEpoch !== requestEpochRef.current) return;
      if (metricsRes.status === 'fulfilled') setMetricsSummary(metricsRes.value.data);
      if (incidentsRes.status === 'fulfilled') setIncidents(incidentsRes.value.data?.incidents || incidentsRes.value.data || []);
      if (detectionsRes.status === 'fulfilled') {
        const data = detectionsRes.value.data;
        setDetections(Array.isArray(data) ? data : data?.detections || []);
      }
      const results = [metricsRes, incidentsRes, detectionsRes];
      const labels = ['metrics', 'incidents', 'diagnostics'];
      const failed = results
        .map((result, index) => (result.status === 'rejected' ? labels[index] : null))
        .filter(Boolean);
      setRefreshState({
        status: failed.length === results.length ? 'error' : failed.length > 0 ? 'partial' : 'fresh',
        checkedAt: new Date(),
        failed,
      });
    } finally {
      if (requestEpoch === requestEpochRef.current) setLoading(false);
    }
  }, [serverId, showIgnored]);

  useEffect(() => { fetchOverviewData(); }, [fetchOverviewData]);

  useEffect(() => {
    const refreshWhenVisible = () => {
      if (document.visibilityState !== 'hidden') fetchOverviewData();
    };
    const iv = setInterval(refreshWhenVisible, 30_000);
    document.addEventListener('visibilitychange', refreshWhenVisible);
    return () => {
      clearInterval(iv);
      document.removeEventListener('visibilitychange', refreshWhenVisible);
    };
  }, [fetchOverviewData]);

  useEffect(() => () => { requestEpochRef.current += 1; }, []);

  // Live: refresh instantly when this server's state changes (player
  // join/leave, map change) via the realtime game topic; the interval
  // above is now just a safety net.
  useRealtimeTopic('game', (evt) => {
    if (
      document.visibilityState !== 'hidden'
      && (evt.event === 'reconnected' || !evt.data?.server_id || evt.data.server_id === serverId)
    ) fetchOverviewData();
  });

  const latest = metricsSummary?.latest || {};
  const trend = metricsSummary?.trend_24h || {};
  const status = server?.status || 'stopped';
  const isRunning = status === 'running';
  const canStart = canStartServer(server);
  const canStop = canStopServer(server);
  const canRestart = canRestartServer(server);
  const modCount = server?.mods?.length || 0;
  const ports = server?.ports || {};
  const troubleshooting = server?.troubleshooting || {};
  const troubleshootingRows = [
    ['Container', troubleshooting.actual_container_name],
    ['Working path', troubleshooting.working_directory],
    ['Config directory', troubleshooting.config_directory],
    ['Profile directory', troubleshooting.profile_directory],
    ['Shell into', troubleshooting.cd_target],
  ].filter(([, value]) => Boolean(value));
  const serverAdminToolsConfigTarget = troubleshooting.profile_directory || troubleshooting.cd_target || '';
  const serverAdminToolsInstalled = (server?.mods || []).some((mod) => {
    const haystack = `${mod.name || ''} ${mod.mod_id || mod.modId || ''}`.toLowerCase();
    return haystack.includes('server admin tools');
  });
  const startupParameters = Array.isArray(server?.startup_parameters) ? server.startup_parameters : [];
  const logStatsEnabled = server?.log_stats_enabled !== false;
  const maxFps = server?.max_fps ?? 120;
  const [locking, setLocking] = useState(false);

  const handleLockdown = useCallback(async () => {
    setLocking(true);
    try {
      const res = await apiClient.post(`/servers/${serverId}/rcon`, { command: '#lock' }, {
        validateStatus: (status) => status < 400,
      });
      // /rcon answers 200 with executed:false when RCON timed out or refused
      // the login; that used to read as "Server locked".
      if (res?.data?.executed === false) {
        toast({
          variant: 'destructive',
          title: 'Lockdown not confirmed',
          description: res.data.response || 'RCON did not accept #lock. Check Live Control > RCON.',
        });
        return;
      }
      toast({ title: 'Server locked', description: 'RCON accepted #lock. Send #unlock from Live Control > RCON to reopen it.' });
    } catch (err) {
      toast({
        variant: 'destructive',
        title: 'Lockdown failed',
        description: formatApiError(err, 'Could not send lockdown command.'),
      });
    } finally {
      setLocking(false);
    }
  }, [server?.name, serverId, user]);

  /* ── Maintenance tasks (folded from Trigger/Exec) ─────────────── */
  const [taskRunning, setTaskRunning] = useState(null);
  const [taskResult, setTaskResult] = useState(null);

  const runTask = useCallback(async (taskId) => {
    setTaskRunning(taskId);
    setTaskResult(null);
    try {
      if (taskId === 'backup') {
        await apiClient.post(`/servers/${serverId}/backups`, null, {
          validateStatus: (status) => status < 400,
        });
        setTaskResult({ ok: true, msg: 'Backup created' });
      } else if (taskId === 'validate') {
        const mods = server?.mods || [];
        const res = await apiClient.post(`/servers/${serverId}/mods/validate`, { mods });
        const issues = res.data?.issues || [];
        setTaskResult({ ok: true, msg: issues.length === 0 ? 'Config valid — no issues' : `${issues.length} issue(s) found` });
      } else if (taskId === 'refresh_mods') {
        const mods = server?.mods || [];
        let ok = 0, fail = 0;
        for (const mod of mods) {
          const modId = mod.mod_id || mod.modId;
          if (modId) {
            try { await apiClient.post(`/servers/workshop/mod/${modId}/refresh`); ok++; } catch { fail++; }
          }
        }
        setTaskResult({ ok: fail === 0, msg: fail > 0 ? `Refreshed ${ok}, ${fail} failed` : `Refreshed ${ok} mod(s)` });
      }
      await fetchServer(true);
    } catch (err) {
      setTaskResult({ ok: false, msg: formatApiError(err, 'Task failed') });
    } finally {
      setTaskRunning(null);
    }
  }, [server?.mods, server?.name, serverId, fetchServer, user]);

  const handleRemoveAllMods = useCallback(async () => {
    setResetting(true);
    try {
      const res = await apiClient.post(`/servers/${serverId}/mods/files/purge`, null, {
        validateStatus: (status) => status < 400,
      });
      const { count = 0, errors = [], scanned_paths = [] } = res.data || {};
      if (errors.length > 0) {
        toast({
          variant: 'destructive',
          title: `Removed ${count} mod(s), ${errors.length} failed`,
          description: errors.slice(0, 3).map((e) => `${e.path}: ${e.error}`).join('; '),
        });
      } else if (count === 0) {
        // No files found to delete: surface where we looked so an empty/wrong
        // mod folder is obvious instead of looking like a silent success.
        toast({
          variant: 'destructive',
          title: 'No mods found to remove',
          description: scanned_paths.length
            ? `Nothing to delete in: ${scanned_paths.join(', ')}`
            : 'The addon folder was empty or could not be located.',
        });
      } else {
        toast({ title: 'Mods removed', description: `Removed ${count} mod(s) from the addon folder.` });
      }
      await fetchServer(true);
      await fetchOverviewData();
      setResetDialogOpen(false);
    } catch (err) {
      toast({
        variant: 'destructive',
        title: 'Remove all mods failed',
        description: formatApiError(err, 'Could not remove mods from the addon folder.'),
      });
    } finally {
      setResetting(false);
    }
  }, [fetchOverviewData, fetchServer, server?.name, serverId, user]);

  const handleRuntimeUpdate = useCallback(async () => {
    setRuntimeDialogOpen(false);
    await handleServerAction?.('update-runtime');
  }, [handleServerAction]);

  const handleMarkSafe = useCallback(async (detectionId) => {
    setVerdictBusy(true);
    try {
      await apiClient.post(`/servers/${serverId}/detections/${detectionId}/verdict`, {
        status: 'ignored',
        verdict_notes: 'Marked safe by operator',
      });
      await fetchOverviewData();
    } finally {
      setVerdictBusy(false);
    }
  }, [fetchOverviewData, serverId]);

  const handleReactivate = useCallback(async (detectionId) => {
    setVerdictBusy(true);
    try {
      await apiClient.post(`/servers/${serverId}/detections/${detectionId}/verdict`, {
        status: 'active',
        verdict_notes: 'Reactivated by operator',
      });
      await fetchOverviewData();
    } finally {
      setVerdictBusy(false);
    }
  }, [fetchOverviewData, serverId]);

  const activeDetections = useMemo(
    () => detections.filter((d) => d.status === 'active' || d.status === 'monitoring'),
    [detections],
  );
  const ignoredDetections = useMemo(
    () => detections.filter((d) => d.status === 'ignored' || d.status === 'false_positive' || d.status === 'resolved'),
    [detections],
  );
  const hasProvisioningIssues = useMemo(() => {
    const stages = server?.provisioning_stages;
    if (!stages || typeof stages !== 'object') return false;
    return Object.values(stages).some(
      (stage) => stage && typeof stage === 'object' && (stage.status === 'failed' || stage.status === 'warning'),
    );
  }, [server?.provisioning_stages]);
  const showDiagnostics = activeDetections.length > 0 || ignoredDetections.length > 0 || isServerDegraded(server) || server?.status === 'error' || hasProvisioningIssues;

  const formatUptime = (seconds) => {
    if (!seconds) return '—';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    if (h > 24) return `${Math.floor(h / 24)}d ${h % 24}h`;
    return `${h}h ${m}m`;
  };

  // The latest sample outlives the process; once the server is down it is
  // history, so the tiles say so instead of showing it as a live reading.
  const live = ['running', 'starting', 'stopping'].includes(status);
  const offlineValue = '—';
  const healthCards = [
    {
      label: 'CPU Usage',
      value: !live ? offlineValue : latest.cpu_host_percent != null || latest.cpu_percent != null ? `${(latest.cpu_host_percent ?? latest.cpu_percent).toFixed(1)}%` : 'Unavailable',
      icon: Cpu,
      color: 'text-brand',
      border: 'border-[rgba(232,131,58,0.14)]',
      trend: trend.avg_cpu != null ? `Avg: ${trend.avg_cpu.toFixed(1)}%` : 'Container metric',
    },
    {
      label: 'Memory',
      value: !live ? offlineValue : latest.memory_mb != null ? `${latest.memory_mb.toFixed(0)} MB` : 'Unavailable',
      icon: HardDrive,
      color: 'text-brand',
      border: 'border-[rgba(232,131,58,0.14)]',
      trend: trend.avg_memory != null ? `Avg: ${trend.avg_memory.toFixed(0)} MB` : 'Container metric',
    },
    {
      label: 'Players',
      value: !live ? offlineValue : latest.player_count != null ? `${latest.player_count}/${latest.max_players || '?'}` : 'Unavailable',
      icon: Users,
      color: 'text-brand',
      border: 'border-[rgba(232,131,58,0.14)]',
      trend: !live ? 'Server offline' : latest.metric_sources?.player_count ? `Source: ${latest.metric_sources.player_count}` : 'Awaiting live RCON data',
    },
    {
      label: 'Uptime',
      value: live ? formatUptime(latest.uptime_seconds) : 'Not running',
      icon: Clock,
      color: 'text-brand',
      border: 'border-brand-dark/20',
      trend: live
        ? (server?.last_started ? `Since: ${new Date(server.last_started).toLocaleString()}` : null)
        : (server?.last_stopped ? `Stopped: ${new Date(server.last_stopped).toLocaleString()}` : null),
    },
  ];

  return (
    <div className="space-y-6">
      {/* Health Cards */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {healthCards.map((card) => {
          const Icon = card.icon;
          return (
            <Card key={card.label} className={`${card.border} bg-mil-bg-deep/60 backdrop-blur-xs`}>
              <CardContent className="p-4">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-mil-muted capitalize">{card.label}</span>
                  <Icon className={`h-4 w-4 ${card.color}`} />
                </div>
                <div className="mt-2 text-2xl font-bold text-white" style={{ fontFamily: "var(--font-heading)" }}>
                  {loading ? <div className="h-8 w-16 animate-pulse rounded bg-zinc-800" /> : card.value}
                </div>
                {card.trend && (
                  <div className="mt-1 text-[11px] text-mil-dim">{card.trend}</div>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>

      {/* ── Diagnostics Panel (compact, collapsible) ────────────────────── */}
      {showDiagnostics && (
        <div className="space-y-2">
          {/* Active diagnostics */}
          {activeDetections.length > 0 && (
            <CollapsibleSection
              title="ACTIVE DIAGNOSTICS"
              icon={AlertTriangle}
              count={activeDetections.length}
              open={diagOpen}
              onToggle={() => setDiagOpen((v) => !v)}
            >
              <div className="space-y-2 max-h-[40vh] overflow-y-auto">
                {activeDetections.map((item) => (
                  <DiagnosticItem
                    key={item.id}
                    item={item}
                    onMarkSafe={handleMarkSafe}
                    onReactivate={handleReactivate}
                    busy={verdictBusy}
                  />
                ))}
              </div>
            </CollapsibleSection>
          )}

          {/* Provisioning stages (collapsed by default when no issues) */}
          {hasProvisioningIssues && (isServerDegraded(server) || server?.status === 'error') && (
            <CollapsibleSection
              title="PROVISIONING STAGES"
              icon={Activity}
              count={Object.keys(server.provisioning_stages).length}
              open={stagesOpen}
              onToggle={() => setStagesOpen((v) => !v)}
              badge={
                isServerDegraded(server)
                  ? <Badge variant="outline" className="ml-1 border-amber-600/30 text-[11px] text-amber-300">needs review</Badge>
                  : server?.status === 'error'
                    ? <Badge variant="outline" className="ml-1 border-red-600/30 text-[11px] text-red-300">failed</Badge>
                    : null
              }
            >
              <div className="space-y-1.5 max-h-[30vh] overflow-y-auto">
                {Object.values(server.provisioning_stages).map((stage) => (
                  <div key={stage.name} className="flex items-center gap-2 text-xs py-0.5">
                    {stage.status === 'success' ? (
                      <CheckCircle className="h-3 w-3 shrink-0 text-green-400" />
                    ) : stage.status === 'failed' ? (
                      <AlertTriangle className="h-3 w-3 shrink-0 text-red-400" />
                    ) : (
                      <Activity className="h-3 w-3 shrink-0 text-mil-dim" />
                    )}
                    <span className={`capitalize ${
                      stage.status === 'success' ? 'text-green-400' :
                      stage.status === 'failed' ? 'text-red-400' :
                      'text-mil-dim'
                    }`}>
                      {stage.name.replace(/_/g, ' ')}
                    </span>
                    {stage.message && <span className="text-mil-dim truncate">{stage.message}</span>}
                    {stage.error && <span className="ml-auto text-red-400/80 text-[11px] truncate max-w-[40%]">{stage.error}</span>}
                  </div>
                ))}
                {currentFailureMessage(server) && (
                  <p className="mt-1 border-t border-zinc-800 pt-1 text-[11px] text-mil-dim">{currentFailureMessage(server)}</p>
                )}
              </div>
            </CollapsibleSection>
          )}

          {/* Ignored / archived diagnostics */}
          {showIgnored && ignoredDetections.length > 0 && (
            <CollapsibleSection
              title="RESOLVED / KNOWN SAFE"
              icon={EyeOff}
              count={ignoredDetections.length}
              open={ignoredOpen}
              onToggle={() => setIgnoredOpen((v) => !v)}
            >
              <div className="space-y-2 max-h-[30vh] overflow-y-auto">
                {ignoredDetections.map((item) => (
                  <DiagnosticItem
                    key={item.id}
                    item={item}
                    onMarkSafe={handleMarkSafe}
                    onReactivate={handleReactivate}
                    busy={verdictBusy}
                  />
                ))}
              </div>
            </CollapsibleSection>
          )}

          {/* Toggle for showing ignored items */}
          <div className="flex items-center gap-2 text-[11px] text-mil-dim">
            <button
              type="button"
              onClick={() => setShowIgnored((v) => !v)}
              className="flex items-center gap-1 hover:text-mil-muted transition-colors"
            >
              {showIgnored ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
              {showIgnored ? 'Hide archived' : 'Show archived'}
            </button>
          </div>
        </div>
      )}

      {/* Open Incidents Alert */}
      {incidents.length > 0 && (() => {
        // Crash loops file one incident per detection; six identical rows
        // said less than one row with a count and the diagnosed cause.
        const groups = [];
        for (const inc of incidents) {
          // Newer records fold repeats into one incident with `occurrences`.
          const seen = Number(inc.occurrences) > 1 ? Number(inc.occurrences) : 1;
          const existing = groups.find((g) => g.title === inc.title);
          if (existing) {
            existing.count += seen;
            if (!existing.diagnosis && inc.diagnosis) existing.diagnosis = inc.diagnosis;
          } else {
            groups.push({ ...inc, count: seen });
          }
        }
        const uptimeSeconds = latest.uptime_seconds;
        const onlineSince = isRunning && uptimeSeconds ? Date.now() - uptimeSeconds * 1000 : null;
        const allBeforeStart = onlineSince && incidents.every((inc) => {
          const seenAt = inc.last_detected_at || inc.detected_at;
          return seenAt && new Date(seenAt).getTime() < onlineSince;
        });
        return (
          <div className={`border p-4 ${allBeforeStart ? 'border-[rgba(232,131,58,0.18)] bg-mil-bg-deep/60' : 'border-red-600/30 bg-red-600/5'}`}>
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <div className={`flex items-center gap-2 text-sm font-semibold ${allBeforeStart ? 'text-mil-soft' : 'text-red-300'}`}>
                <AlertTriangle className="h-4 w-4" />
                {incidents.length} open incident{incidents.length > 1 ? 's' : ''}
              </div>
              {allBeforeStart ? (
                <span className="text-xs text-mil-dim">All raised before the current run started; review and resolve.</span>
              ) : null}
            </div>
            <ul className="space-y-2.5">
              {groups.slice(0, 3).map((group) => (
                <li key={group.id || group.title} className="text-xs">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="outline" className={`text-[11px] ${
                      group.severity === 'critical' ? 'border-red-600/50 text-red-300' :
                      group.severity === 'high' ? 'border-amber-600/50 text-amber-300' :
                      'border-zinc-600/50 text-zinc-400'
                    }`}>
                      {group.severity?.toUpperCase()}
                    </Badge>
                    <span className="min-w-[12rem] flex-1 text-mil-fg">{group.title}{group.count > 1 ? ` ×${group.count}` : ''}</span>
                    <span className="basis-full text-mil-dim sm:basis-auto">{(group.last_detected_at || group.detected_at) ? new Date(group.last_detected_at || group.detected_at).toLocaleString() : ''}</span>
                  </div>
                  {group.diagnosis ? (
                    <p className="mt-1 pl-1 text-mil-muted">
                      <span className="text-mil-soft">{group.diagnosis.title}</span>
                      {group.diagnosis.culprits?.length ? ` — ${group.diagnosis.culprits.map((c) => c.name).join(', ')}` : ''}
                    </p>
                  ) : null}
                </li>
              ))}
            </ul>
            <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs">
              <Link to="diagnosis" className="font-medium text-brand-light hover:underline">Crash analysis →</Link>
              <Link to="tools/watchers?tab=incidents" className="text-mil-muted hover:text-mil-fg">All incidents →</Link>
            </div>
          </div>
        );
      })()}

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Server Identity */}
        <Card className="border-zinc-800 bg-mil-bg-deep/60">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-sm font-semibold tracking-wider text-mil-muted">
              <Server className="h-4 w-4 text-brand" /> SERVER IDENTITY
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <DetailRow label="Display Name" value={server.name} />
            <DetailRow label="Description" value={server.description || '—'} />
            <DetailRow label="Docker Image" value={server.docker_image} mono />
            <DetailRow label="Docker Container" value={troubleshooting.actual_container_name || server.container_name} mono />
            <DetailRow label="Created By" value={server.created_by_name || server.created_by || '—'} mono={!server.created_by_name} />
            <DetailRow label="Created" value={server.created_at ? new Date(server.created_at).toLocaleString() : '—'} />
          </CardContent>
        </Card>

        {/* Network & Ports */}
        <Card className="border-zinc-800 bg-mil-bg-deep/60">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-sm font-semibold tracking-wider text-mil-muted">
              <Network className="h-4 w-4 text-brand" /> NETWORK
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <DetailRow label="Game Port" value={ports.game || '2001'} mono />
            <DetailRow label="Query Port" value={ports.query || '17777'} mono />
            <DetailRow label="RCON Port" value={ports.rcon || '19999'} mono />
            <div className="pt-2">
              <span className="text-xs font-medium text-mil-dim">Tags</span>
              <div className="mt-1 flex flex-wrap gap-1.5">
                {(server.tags || []).length > 0 ? server.tags.map((tag) => (
                  <Badge key={tag} variant="outline" className="border-brand-dark/30 text-brand text-[11px]">
                    {tag}
                  </Badge>
                )) : <span className="text-xs text-mil-dim">No tags</span>}
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Mods Summary */}
        <Card className="border-zinc-800 bg-mil-bg-deep/60">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-sm font-semibold tracking-wider text-mil-muted">
              <Puzzle className="h-4 w-4 text-brand" /> MODS
              <Badge variant="outline" className="ml-auto border-zinc-700 text-xs text-mil-muted">{modCount}</Badge>
            </CardTitle>
          </CardHeader>
          <CardContent>
            {modCount > 0 ? (
              <div className="space-y-1.5">
                {server.mods.slice(0, 5).map((mod, i) => (
                  <div key={i} className="flex items-center gap-2 rounded border border-zinc-800/50 bg-zinc-900/30 px-3 py-1.5 text-xs">
                    <span className="text-mil-muted">{i + 1}.</span>
                    <span className="text-mil-fg">{mod.name || mod.mod_id || mod.modId}</span>
                  </div>
                ))}
                {modCount > 5 && (
                  <Link to="mods" className="block pt-1 text-xs text-brand hover:text-brand-light">
                    +{modCount - 5} more mods →
                  </Link>
                )}
              </div>
            ) : (
              <p className="text-xs text-mil-dim">No mods configured</p>
            )}
          </CardContent>
        </Card>

        {/* Actions. Start, stop and restart live in the workspace header and
            every module is in the sidebar, so this card holds only the
            server-level jobs that have no other home. */}
        <Card className="border-zinc-800 bg-mil-bg-deep/60">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-sm font-semibold tracking-wider text-mil-muted">
              <Activity className="h-4 w-4 text-brand" /> ACTIONS
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <Button variant="outline" size="sm" onClick={handleLockdown} disabled={!isRunning || locking || !!actionLoading}
                className="justify-start border-white/10 text-mil-soft hover:border-[rgba(232,131,58,0.35)] hover:text-brand-light">
                {locking ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Lock className="mr-2 h-4 w-4" />} Lockdown
              </Button>
              {canManage && (
                <Button variant="outline" size="sm" onClick={() => setRuntimeDialogOpen(true)} disabled={resetting || !!actionLoading}
                  className="justify-start border-white/10 text-mil-soft hover:border-[rgba(232,131,58,0.35)] hover:text-brand-light">
                  {actionLoading === 'update-runtime' ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Server className="mr-2 h-4 w-4" />} Update Runtime
                </Button>
              )}
              <Button variant="outline" size="sm" onClick={() => runTask('backup')} disabled={!!taskRunning}
                className="justify-start border-white/10 text-mil-soft hover:border-[rgba(232,131,58,0.35)] hover:text-brand-light">
                {taskRunning === 'backup' ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <HardDrive className="mr-2 h-4 w-4" />} Backup
              </Button>
              <Button variant="outline" size="sm" onClick={() => runTask('validate')} disabled={!!taskRunning}
                className="justify-start border-white/10 text-mil-soft hover:border-[rgba(232,131,58,0.35)] hover:text-brand-light">
                {taskRunning === 'validate' ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <ShieldCheck className="mr-2 h-4 w-4" />} Validate
              </Button>
              <Button variant="outline" size="sm" onClick={() => runTask('refresh_mods')} disabled={!!taskRunning}
                className="justify-start border-white/10 text-mil-soft hover:border-[rgba(232,131,58,0.35)] hover:text-brand-light">
                {taskRunning === 'refresh_mods' ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Puzzle className="mr-2 h-4 w-4" />} Re-ingest Mods
              </Button>
            </div>
            {taskResult && (
              <div className={`rounded border px-3 py-1.5 text-xs ${taskResult.ok ? 'border-green-700/30 text-green-400' : 'border-red-700/30 text-red-400'}`}>
                {taskResult.msg}
              </div>
            )}
            <div className="border-t border-zinc-800 pt-3">
              <Button variant="outline" size="sm" onClick={() => setResetDialogOpen(true)} disabled={resetting || !!actionLoading}
                className="w-full justify-start border-red-800/40 text-red-300 hover:bg-red-900/20 hover:text-red-200 sm:w-auto">
                {resetting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Trash2 className="mr-2 h-4 w-4" />} Remove All Mods
              </Button>
              <p className="mt-1.5 text-xs text-mil-muted">
                Deletes every downloaded mod from the addon folder. The server re-downloads its configured mods on the next start. Best run while it is stopped.
              </p>
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card className="border-zinc-800 bg-mil-bg-deep/60">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-sm font-semibold tracking-wider text-mil-muted">
              <ShieldAlert className="h-4 w-4 text-brand" /> SERVER ADMIN TOOLS
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <DetailRow label="Installed" value={serverAdminToolsInstalled ? 'Detected in mod list' : 'Not detected'} />
            <DetailRow label="Config Target" value={serverAdminToolsConfigTarget ? `${serverAdminToolsConfigTarget}/ServerAdminTools_Config.json` : '—'} mono />
            <DetailRow label="Bootstrap Status" value={serverAdminToolsInstalled ? 'Ready for admin troubleshooting' : 'Awaiting mod installation'} />
            <DetailRow label="logStats" value={logStatsEnabled ? 'Enabled by runtime defaults' : 'Disabled'} />
            <DetailRow label="Max FPS" value={String(maxFps)} mono />
            <div>
              <span className="text-xs font-medium text-mil-dim">Startup Parameters</span>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {startupParameters.length > 0 ? startupParameters.map((param) => (
                  <Badge key={param} variant="outline" className="border-zinc-700 text-mil-muted">{param}</Badge>
                )) : <span className="text-xs text-mil-dim">No extra startup parameters configured</span>}
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="border-zinc-800 bg-mil-bg-deep/60">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-sm font-semibold tracking-wider text-mil-muted">
              <Settings className="h-4 w-4 text-brand" /> HOST PATHS
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {troubleshootingRows.length > 0 ? troubleshootingRows.map(([label, value]) => (
              <DetailRow key={label} label={label} value={value} mono />
            )) : (
              <p className="text-xs text-mil-muted">
                The backend has not reported container paths for this server yet. They appear once the container has been inspected.
              </p>
            )}
          </CardContent>
        </Card>
      </div>

      <div
        role={['partial', 'error'].includes(refreshState.status) ? 'alert' : 'status'}
        className={`flex items-center justify-end gap-2 text-xs ${refreshState.status === 'fresh' ? 'text-mil-muted' : 'text-amber-300'}`}
      >
        <span className={`h-2 w-2 rounded-full ${refreshState.status === 'fresh' ? 'bg-green-400' : 'bg-amber-400'}`} aria-hidden="true" />
        {refreshState.status === 'loading' && 'Loading overview data'}
        {refreshState.status === 'fresh' && `Overview updated ${refreshState.checkedAt?.toLocaleTimeString()}`}
        {refreshState.status === 'partial' && `Overview partially updated ${refreshState.checkedAt?.toLocaleTimeString()} · unavailable: ${refreshState.failed.join(', ')}`}
        {refreshState.status === 'error' && `Overview update failed ${refreshState.checkedAt?.toLocaleTimeString()} · showing last known data`}
      </div>

      <Dialog open={resetDialogOpen} onOpenChange={setResetDialogOpen}>
        <DialogContent className="border-red-700/30 bg-zinc-950 text-white">
          <DialogHeader>
            <DialogTitle className="text-red-300">Remove All Mods</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-mil-muted">
            This permanently deletes every downloaded mod from the server's addon folder on disk. The server will re-download its configured mods on the next start. For best results, stop the server first so no files are locked.
          </p>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" size="sm" onClick={() => setResetDialogOpen(false)} className="border-zinc-700 text-mil-muted">
              Cancel
            </Button>
            <Button size="sm" onClick={handleRemoveAllMods} disabled={resetting} className="bg-red-600 text-white hover:bg-red-500">
              {resetting ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Trash2 className="mr-1.5 h-4 w-4" />}
              Remove All Mods
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={runtimeDialogOpen} onOpenChange={setRuntimeDialogOpen}>
        <DialogContent className="border-[rgba(232,131,58,0.3)] bg-zinc-950 text-white">
          <DialogHeader>
            <DialogTitle className="text-brand-light">Update Server Runtime</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-mil-muted">
            This pulls the configured Docker image and replaces only the disposable container/runtime layer. The existing config, profile, workshop/mod files, and saved server settings stay in their persistent host folders and are mounted back into the replacement container. Because the game installation itself is container-local, the next start may download and validate roughly 10.7 GB. A running server restarts after downtime; a stopped server remains stopped.
          </p>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" size="sm" onClick={() => setRuntimeDialogOpen(false)} className="border-zinc-700 text-mil-muted">
              Cancel
            </Button>
            <Button size="sm" onClick={handleRuntimeUpdate} disabled={!!actionLoading} className="bg-brand text-black hover:bg-brand-light">
              {actionLoading === 'update-runtime' ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Server className="mr-1.5 h-4 w-4" />}
              Update Runtime
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function DetailRow({ label, value, mono }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <span className="text-xs font-medium text-mil-dim">{label}</span>
      <span className={`text-right text-sm text-mil-fg ${mono ? 'font-mono text-xs' : ''}`}>{value}</span>
    </div>
  );
}

export default OverviewModule;
