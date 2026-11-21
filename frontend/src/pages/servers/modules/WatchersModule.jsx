import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useOutletContext } from 'react-router';
import apiClient from '@/lib/apiClient';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useUnsavedChanges } from '@/context/UnsavedChangesContext';
import {
  Activity,
  AlertTriangle,
  FileText,
  Loader2,
  Plus,
  RefreshCw,
  ShieldCheck,
  ShieldPlus,
  Trash2,
} from 'lucide-react';
import { formatApiError } from '@/utils/errorMessages';
import useConfirmDialog from '@/hooks/useConfirmDialog';

const WATCHER_TYPES = [
  { value: 'health', label: 'Health Watcher', desc: 'Watch crash loops, readiness, and degraded state' },
  { value: 'log', label: 'Log Watcher', desc: 'Match merged logs with a regex pattern' },
  { value: 'threshold', label: 'Threshold Watcher', desc: 'Alert when a metric crosses a threshold' },
];

const WATCHER_CATEGORIES = [
  { value: 'runtime-script', label: 'Runtime' },
  { value: 'mod_issue', label: 'Mod / Workshop' },
  { value: 'battleye_rcon', label: 'BattlEye / RCON' },
  { value: 'admin_action', label: 'Admin / Moderation' },
  { value: 'performance', label: 'Performance' },
  { value: 'engine', label: 'Engine / Health' },
];

const THRESHOLD_COMPARISONS = [
  { value: 'gt', label: '>' },
  { value: 'gte', label: '>=' },
  { value: 'lt', label: '<' },
  { value: 'lte', label: '<=' },
];

const SEVERITY_OPTIONS = ['low', 'medium', 'high', 'critical'];
const VERDICT_OPTIONS = ['active', 'monitoring', 'resolved', 'false_positive'];

function watcherIcon(type) {
  if (type === 'health') return <Activity className="h-4 w-4 text-green-400" />;
  if (type === 'log') return <FileText className="h-4 w-4 text-blue-400" />;
  return <AlertTriangle className="h-4 w-4 text-amber-400" />;
}

function severityTone(severity) {
  return {
    low: 'border-zinc-700 text-zinc-300',
    medium: 'border-blue-600/30 text-blue-300',
    high: 'border-amber-600/30 text-amber-300',
    critical: 'border-red-600/30 text-red-300',
  }[severity] || 'border-zinc-700 text-zinc-300';
}

function verdictTone(status) {
  return {
    active: 'border-red-600/30 text-red-300',
    monitoring: 'border-amber-600/30 text-amber-300',
    resolved: 'border-green-600/30 text-green-300',
    false_positive: 'border-zinc-700 text-zinc-300',
  }[status] || 'border-zinc-700 text-zinc-300';
}

function comparisonLabel(value) {
  return THRESHOLD_COMPARISONS.find((item) => item.value === value)?.label || '>';
}

function humanizeSourceCategory(value) {
  return String(value)
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function sourceCategoryLabel(value) {
  const label = WATCHER_CATEGORIES.find((item) => item.value === value)?.label;
  if (label) return label;
  if (!value) return 'Unclassified';
  return humanizeSourceCategory(value);
}

function defaultWatcherState() {
  return {
    name: '',
    type: 'health',
    pattern: '',
    metric: 'cpu_percent',
    comparison: 'gt',
    threshold: 90,
    enabled: true,
    notify: true,
    severity: 'medium',
    source_category: 'runtime-script',
    description: '',
  };
}

function WatchersModule() {
  const { serverId, user, server } = useOutletContext();
  const { registerDirtySource } = useUnsavedChanges();
  const [watchers, setWatchers] = useState([]);
  const [detections, setDetections] = useState([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [newWatcher, setNewWatcher] = useState(defaultWatcherState);
  // Kept apart from `error` so the 30s poll does not wipe an action's error,
  // and so a failed load is not rendered as "No watchers configured".
  const [loadError, setLoadError] = useState('');
  const { confirm, dialog: confirmDialog } = useConfirmDialog();

  const fetchData = useCallback(async ({ silent = false } = {}) => {
    if (!silent) setLoading(true);
    try {
      const [watchersRes, detectionsRes] = await Promise.allSettled([
        apiClient.get(`/servers/${serverId}/watchers`),
        apiClient.get(`/servers/${serverId}/detections`),
      ]);

      if (watchersRes.status === 'fulfilled') setWatchers(Array.isArray(watchersRes.value.data) ? watchersRes.value.data : []);
      if (detectionsRes.status === 'fulfilled') setDetections(Array.isArray(detectionsRes.value.data) ? detectionsRes.value.data : []);
      const failed = [watchersRes, detectionsRes].find((result) => result.status === 'rejected');
      setLoadError(failed ? formatApiError(failed.reason, 'Failed to load watchers.') : '');
    } finally {
      if (!silent) setLoading(false);
    }
  }, [serverId]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  useEffect(() => {
    const intervalId = setInterval(() => fetchData({ silent: true }), 30_000);
    return () => clearInterval(intervalId);
  }, [fetchData]);

  const detectionsByWatcher = useMemo(() => detections.reduce((map, detection) => {
    const watcherId = detection.watcher_id || 'unassigned';
    if (!map[watcherId]) map[watcherId] = [];
    map[watcherId].push(detection);
    return map;
  }, {}), [detections]);

  const addWatcher = useCallback(async () => {
    if (!newWatcher.name.trim()) return;
    setSaving(true);
    setError('');
    setMessage('');
    try {
      const watcherPayload = {
        name: newWatcher.name.trim(),
        type: newWatcher.type,
        pattern: newWatcher.pattern,
        metric: newWatcher.metric,
        comparison: newWatcher.comparison,
        threshold: Number(newWatcher.threshold) || 0,
        enabled: newWatcher.enabled,
        notify: newWatcher.notify,
        severity: newWatcher.severity,
        source_category: newWatcher.source_category,
        description: newWatcher.description.trim(),
      };
      await apiClient.post(`/servers/${serverId}/watchers`, watcherPayload, {
        validateStatus: (s) => s < 400,
      });
      setDialogOpen(false);
      setNewWatcher(defaultWatcherState());
      setMessage('Watcher created.');
      await fetchData();
    } catch (err) {
      setError(formatApiError(err, 'Failed to create watcher.'));
    } finally {
      setSaving(false);
    }
  }, [fetchData, newWatcher, serverId, user]);

  const restoreEssentials = useCallback(async () => {
    setError('');
    setMessage('');
    try {
      const res = await apiClient.post(`/servers/${serverId}/watchers/seed-defaults`);
      const createdCount = res.data?.created_count || 0;
      setMessage(createdCount > 0 ? `Installed ${createdCount} essential watcher(s).` : 'Essential watcher coverage is already installed.');
      setWatchers(Array.isArray(res.data?.watchers) ? res.data.watchers : []);
      await fetchData();
    } catch (err) {
      setError(formatApiError(err, 'Failed to restore essential watcher coverage.'));
    }
  }, [fetchData, serverId]);

  const updateWatcher = useCallback(async (watcherId, updates) => {
    try {
      await apiClient.put(`/servers/${serverId}/watchers/${watcherId}`, updates, {
        validateStatus: (s) => s < 400,
      });
      await fetchData();
    } catch (err) {
      setError(formatApiError(err, 'Failed to update watcher.'));
    }
  }, [fetchData, serverId, user, watchers]);

  const removeWatcher = useCallback(async (watcherId) => {
    const watcher = watchers.find((item) => item.id === watcherId) || {};
    if (!(await confirm({
      title: 'Delete Watcher',
      description: `Delete the "${watcher.name || 'unnamed'}" watcher? Its detections stop updating.`,
      destructive: true,
      confirmLabel: 'Delete',
    }))) {
      return;
    }
    try {
      await apiClient.delete(`/servers/${serverId}/watchers/${watcherId}`, {
        validateStatus: (s) => s < 400,
      });
      await fetchData();
    } catch (err) {
      setError(formatApiError(err, 'Failed to delete watcher.'));
    }
  }, [confirm, fetchData, serverId, user, watchers]);

  const updateDetectionVerdict = useCallback(async (detectionId, status) => {
    try {
      await apiClient.post(`/servers/${serverId}/detections/${detectionId}/verdict`, { status });
      await fetchData();
    } catch (err) {
      setError(formatApiError(err, 'Failed to update detection verdict.'));
    }
  }, [fetchData, serverId]);

  const newWatcherDirty = Boolean(newWatcher.name.trim());
  // The backend skips an empty or invalid pattern without telling anyone, so
  // the watcher would exist and never fire.
  const patternProblem = useMemo(() => {
    if (newWatcher.type !== 'log') return '';
    const pattern = String(newWatcher.pattern || '').trim();
    if (!pattern) return 'A log watcher needs a pattern to match.';
    try {
      new RegExp(pattern, 'i');
      return '';
    } catch {
      return 'That is not a valid regular expression.';
    }
  }, [newWatcher.pattern, newWatcher.type]);

  const discardWatcherDraft = useCallback(() => {
    setDialogOpen(false);
    setNewWatcher(defaultWatcherState());
  }, []);

  useEffect(() => registerDirtySource({
    id: 'server-watcher-draft',
    label: 'Watcher draft',
    summary: newWatcherDirty ? `Create ${newWatcher.type} watcher "${newWatcher.name.trim()}"` : 'Watcher draft pending',
    dirty: newWatcherDirty,
    onSave: addWatcher,
    onDiscard: discardWatcherDraft,
    onSaved: async () => {
      setDialogOpen(false);
      setNewWatcher(defaultWatcherState());
      await fetchData({ silent: true });
    },
  }), [
    addWatcher,
    discardWatcherDraft,
    fetchData,
    newWatcher.name,
    newWatcher.type,
    newWatcherDirty,
    registerDirtySource,
    server?.name,
    serverId,
  ]);

  const enabledWatchers = watchers.filter((watcher) => watcher.enabled !== false).length;
  const systemManagedWatchers = watchers.filter((watcher) => watcher.system_managed).length;
  const activeDetections = detections.filter((detection) => detection.status === 'active').length;

  return (
    <div className="space-y-6">
      {confirmDialog}
      {loadError ? (
        <div role="alert" className="flex items-center gap-2 rounded border border-red-600/30 bg-red-600/10 px-3 py-2 text-xs text-red-300">
          <span className="min-w-0 flex-1">{loadError}</span>
          <button type="button" onClick={() => fetchData()} className="min-h-11 px-2 hover:text-red-100 sm:min-h-0">Try again</button>
        </div>
      ) : null}
      {/* Title and purpose come from the shared module header above. */}
      <div className="flex flex-wrap items-center justify-end gap-3">
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" onClick={fetchData} className="h-7 border-zinc-800 text-xs text-mil-muted">
            <RefreshCw className={`mr-1 h-3 w-3 ${loading ? 'animate-spin' : ''}`} /> Refresh
          </Button>
          <Button size="sm" variant="outline" onClick={restoreEssentials} className="h-7 border-zinc-800 text-xs text-mil-muted">
            <ShieldPlus className="mr-1 h-3 w-3" /> Restore Essentials
          </Button>
          <Button size="sm" onClick={() => setDialogOpen(true)} className="h-7 bg-brand text-xs text-black hover:bg-brand-light">
            <Plus className="mr-1 h-3 w-3" /> Add Watcher
          </Button>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <Card className="border-zinc-800 bg-mil-bg-deep/60">
          <CardContent className="p-4">
            <div className="text-xs text-mil-muted font-medium">Coverage</div>
            <div className="mt-2 text-2xl font-semibold text-white">{watchers.length}</div>
            <div className="mt-1 text-xs text-mil-dim">{enabledWatchers} enabled, {systemManagedWatchers} essential</div>
          </CardContent>
        </Card>
        <Card className="border-zinc-800 bg-mil-bg-deep/60">
          <CardContent className="p-4">
            <div className="text-xs text-mil-muted font-medium">Live Alerts</div>
            <div className="mt-2 text-2xl font-semibold text-white">{activeDetections}</div>
            <div className="mt-1 text-xs text-mil-dim">{detections.length} detections on record</div>
          </CardContent>
        </Card>
        <Card className="border-zinc-800 bg-mil-bg-deep/60">
          <CardContent className="p-4">
            <div className="text-xs text-mil-muted font-medium">Auto Cycle</div>
            <div className="mt-2 text-2xl font-semibold text-white">30s</div>
            <div className="mt-1 text-xs text-mil-dim">Watcher evaluation and UI refresh cadence</div>
          </CardContent>
        </Card>
      </div>

      {message ? (
        <div className="rounded border border-green-600/30 bg-green-600/10 px-3 py-2 text-xs text-green-300">
          {message}
        </div>
      ) : null}

      {error ? (
        <div className="rounded border border-red-600/30 bg-red-600/10 px-3 py-2 text-xs text-red-400">
          {error}
        </div>
      ) : null}

      {loading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="h-5 w-5 animate-spin text-brand" />
        </div>
      ) : watchers.length === 0 ? (
        <Card className="border-zinc-800 bg-mil-bg-deep/60">
          <CardContent className="flex flex-col items-center justify-center py-12">
            <ShieldCheck className="mb-2 h-8 w-8 text-mil-dim" />
            <p className="text-sm text-mil-dim">No watchers configured</p>
            <p className="mt-1 text-xs text-mil-dim">Restore the essential coverage pack or add a custom watcher.</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {watchers.map((watcher) => {
            const watcherDetections = detectionsByWatcher[watcher.id] || [];
            return (
              <Card key={watcher.id} className={`border-zinc-800 bg-mil-bg-deep/60 ${!watcher.enabled ? 'opacity-60' : ''}`}>
                <CardContent className="space-y-3 p-4">
                  <div className="flex items-start gap-3">
                    <div className="pt-0.5">{watcherIcon(watcher.type)}</div>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-medium text-mil-fg">{watcher.name}</span>
                        <Badge variant="outline" className="border-zinc-700 text-[11px] text-mil-muted">
                          {watcher.type}
                        </Badge>
                        <Badge variant="outline" className={`text-[11px] ${severityTone(watcher.severity)}`}>
                          {watcher.severity}
                        </Badge>
                        <Badge variant="outline" className="border-zinc-700 text-[11px] text-mil-muted">
                          {sourceCategoryLabel(watcher.source_category)}
                        </Badge>
                        {watcher.system_managed ? (
                          <Badge variant="outline" className="border-brand/30 text-[11px] text-brand">
                            essential
                          </Badge>
                        ) : null}

                      </div>
                      <div className="mt-1 text-[11px] text-mil-dim">
                        {watcher.type === 'log' && watcher.pattern ? (
                          <span>Pattern: <code className="text-mil-muted">{watcher.pattern}</code></span>
                        ) : null}
                        {watcher.type === 'threshold' ? (
                          <span>{watcher.metric} {comparisonLabel(watcher.comparison)} {watcher.threshold}</span>
                        ) : null}
                        {watcher.type === 'health' ? (
                          <span>Monitoring deployment state, runtime health, and degraded readiness.</span>
                        ) : null}
                      </div>
                      {watcher.description ? <p className="mt-2 text-xs text-mil-muted">{watcher.description}</p> : null}
                      <div className="mt-2 flex flex-wrap gap-4 text-[11px] text-mil-dim">
                        <span>Triggers: {watcher.trigger_count || 0}</span>
                        <span>Recent detections: {watcherDetections.length}</span>
                        {watcher.last_triggered_at ? <span>Last triggered: {new Date(watcher.last_triggered_at).toLocaleString()}</span> : null}
                      </div>
                    </div>
                    <Switch checked={watcher.enabled} onCheckedChange={() => updateWatcher(watcher.id, { enabled: !watcher.enabled })} className="h-4 w-7" />
                    {!watcher.system_managed ? (
                      <button aria-label="Delete" onClick={() => removeWatcher(watcher.id)} className="text-mil-dim hover:text-red-400">
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    ) : null}
                  </div>

                  {watcher.recommended_actions?.length > 0 ? (
                    <div className="rounded-lg border border-zinc-800/70 bg-zinc-950/60 p-3">
                      <div className="mb-2 text-xs font-medium text-mil-muted">
                        Recommended Response
                      </div>
                      <div className="space-y-1">
                        {watcher.recommended_actions.map((action, index) => (
                          <div key={`${watcher.id}-action-${index}`} className="text-xs text-mil-muted">
                            {action}
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : null}

                  {watcherDetections.length > 0 ? (
                    <div className="rounded-lg border border-zinc-800/70 bg-zinc-950/60 p-3">
                      <div className="mb-2 text-xs font-medium text-mil-muted">
                        Recent Detections
                      </div>
                      <div className="space-y-2">
                        {watcherDetections.slice(0, 3).map((detection) => (
                          <div key={detection.id} className="rounded border border-zinc-800 bg-mil-bg-deep/40 p-2">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="text-xs font-medium text-mil-fg">{detection.title}</span>
                              <Badge variant="outline" className={`text-[11px] ${verdictTone(detection.status)}`}>
                                {detection.status}
                              </Badge>
                              <Badge variant="outline" className="border-zinc-700 text-[11px] text-mil-muted">
                                {sourceCategoryLabel(detection.source_category)}
                              </Badge>
                            </div>
                            <p className="mt-1 text-xs text-mil-muted">{detection.summary}</p>
                            <div className="mt-2 flex flex-wrap gap-2 text-[11px] text-mil-dim">
                              <span>{detection.occurrence_count || 0} observations</span>
                              {detection.last_seen ? <span>Last seen: {new Date(detection.last_seen).toLocaleString()}</span> : null}
                            </div>
                            <div className="mt-2 flex flex-wrap gap-1.5">
                              {VERDICT_OPTIONS.map((status) => (
                                <Button
                                  key={status}
                                  size="sm"
                                  variant="outline"
                                  onClick={() => updateDetectionVerdict(detection.id, status)}
                                  className={`h-6 text-[11px] ${detection.status === status ? 'border-brand/40 text-brand' : 'border-zinc-800 text-mil-muted'}`}
                                >
                                  {status.replace(/_/g, ' ')}
                                </Button>
                              ))}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : null}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {detections.length > 0 ? (
        <Card className="border-zinc-800 bg-mil-bg-deep/60">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-sm tracking-[0.06em] text-mil-fg">
              <ShieldCheck className="h-4 w-4 text-brand" /> DETECTION FEED
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {detections.slice(0, 8).map((detection) => (
              <div key={detection.id} className="rounded-xl border border-zinc-800/70 bg-zinc-950/70 p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm text-mil-fg">{detection.title}</span>
                  <Badge variant="outline" className={`text-[11px] ${verdictTone(detection.status)}`}>
                    {detection.status}
                  </Badge>
                  <Badge variant="outline" className={`text-[11px] ${severityTone(detection.severity)}`}>
                    {detection.severity}
                  </Badge>
                </div>
                <div className="mt-1 text-xs text-mil-dim">
                  {(detection.source_streams || []).join(', ') || 'No source streams recorded'}
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      ) : null}

      <Dialog open={dialogOpen} onOpenChange={(open) => (open ? setDialogOpen(true) : discardWatcherDraft())}>
        <DialogContent className="w-[95vw] max-w-lg border-zinc-800 bg-zinc-950 text-white">
          <DialogHeader>
            <DialogTitle className="text-brand">Add Watcher</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <label className="text-xs text-mil-muted">Name</label>
              <Input
                value={newWatcher.name}
                onChange={(e) => setNewWatcher((prev) => ({ ...prev, name: e.target.value }))}
                placeholder="e.g. Peak-hour ping guard"
                className="mt-1 border-zinc-800 bg-mil-bg-deep/60 text-sm text-white"
              />
            </div>

            <div>
              <label className="text-xs text-mil-muted">Type</label>
              <div className="mt-1 grid grid-cols-1 sm:grid-cols-3 gap-2">
                {WATCHER_TYPES.map((watcherType) => (
                  <button
                    key={watcherType.value}
                    onClick={() => setNewWatcher((prev) => ({ ...prev, type: watcherType.value }))}
                    className={`rounded border p-2 text-left text-xs transition-colors ${
                      newWatcher.type === watcherType.value
                        ? 'border-brand/30 bg-brand/10 text-brand'
                        : 'border-zinc-800 text-mil-dim hover:border-zinc-700'
                    }`}
                  >
                    <div className="font-medium">{watcherType.label}</div>
                    <div className="mt-0.5 text-[11px] opacity-70">{watcherType.desc}</div>
                  </button>
                ))}
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label className="text-xs text-mil-muted">Severity</label>
                <select
                  value={newWatcher.severity}
                  onChange={(e) => setNewWatcher((prev) => ({ ...prev, severity: e.target.value }))}
                  className="mt-1 w-full rounded border border-zinc-800 bg-mil-bg-deep/60 px-3 py-2 text-sm text-white"
                >
                  {SEVERITY_OPTIONS.map((severity) => (
                    <option key={severity} value={severity}>{severity}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="text-xs text-mil-muted">Category</label>
                <select
                  value={newWatcher.source_category}
                  onChange={(e) => setNewWatcher((prev) => ({ ...prev, source_category: e.target.value }))}
                  className="mt-1 w-full rounded border border-zinc-800 bg-mil-bg-deep/60 px-3 py-2 text-sm text-white"
                >
                  {WATCHER_CATEGORIES.map((category) => (
                    <option key={category.value} value={category.value}>{category.label}</option>
                  ))}
                </select>
              </div>
            </div>

            {/* No "Notify on trigger" switch: the backend stores the flag but
                nothing reads it; every detection shows here either way. */}

            <div>
              <label className="text-xs text-mil-muted">Description</label>
              <Input
                value={newWatcher.description}
                onChange={(e) => setNewWatcher((prev) => ({ ...prev, description: e.target.value }))}
                placeholder="What should operators understand about this watcher?"
                className="mt-1 border-zinc-800 bg-mil-bg-deep/60 text-sm text-white"
              />
            </div>

            {newWatcher.type === 'log' ? (
              <div>
                <label className="text-xs text-mil-muted">Regex Pattern</label>
                <Input
                  value={newWatcher.pattern}
                  onChange={(e) => setNewWatcher((prev) => ({ ...prev, pattern: e.target.value }))}
                  placeholder="error|fatal|crash"
                  aria-invalid={Boolean(patternProblem)}
                  className="mt-1 border-zinc-800 bg-mil-bg-deep/60 font-mono text-sm text-white"
                />
                {patternProblem ? <p className="mt-1 text-[11px] text-amber-300">{patternProblem}</p> : null}
              </div>
            ) : null}

            {newWatcher.type === 'threshold' ? (
              <div className="grid gap-3 sm:grid-cols-3">
                <div>
                  <label className="text-xs text-mil-muted">Metric</label>
                  <select
                    value={newWatcher.metric}
                    onChange={(e) => setNewWatcher((prev) => ({ ...prev, metric: e.target.value }))}
                    className="mt-1 w-full rounded border border-zinc-800 bg-mil-bg-deep/60 px-3 py-2 text-sm text-white"
                  >
                    <option value="cpu_percent">CPU %</option>
                    <option value="memory_mb">Memory MB</option>
                    <option value="player_count">Player Count</option>
                    <option value="server_fps">Server FPS</option>
                    <option value="avg_player_ping_ms">Avg Ping</option>
                  </select>
                </div>
                <div>
                  <label className="text-xs text-mil-muted">Comparison</label>
                  <select
                    value={newWatcher.comparison}
                    onChange={(e) => setNewWatcher((prev) => ({ ...prev, comparison: e.target.value }))}
                    className="mt-1 w-full rounded border border-zinc-800 bg-mil-bg-deep/60 px-3 py-2 text-sm text-white"
                  >
                    {THRESHOLD_COMPARISONS.map((comparison) => (
                      <option key={comparison.value} value={comparison.value}>{comparison.label}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="text-xs text-mil-muted">Threshold</label>
                  <Input
                    type="number"
                    value={newWatcher.threshold}
                    step="any"
                    onChange={(e) => setNewWatcher((prev) => ({ ...prev, threshold: e.target.value }))}
                    className="mt-1 border-zinc-800 bg-mil-bg-deep/60 text-sm text-white"
                  />
                </div>
              </div>
            ) : null}
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" size="sm" onClick={discardWatcherDraft} className="border-zinc-700 text-mil-muted">
              Cancel
            </Button>
            <Button size="sm" onClick={addWatcher} disabled={!newWatcher.name.trim() || Boolean(patternProblem) || saving} className="bg-brand text-black hover:bg-brand-light">
              {saving ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : null}
              Create Watcher
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export default WatchersModule;
