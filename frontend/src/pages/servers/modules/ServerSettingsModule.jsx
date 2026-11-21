import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useOutletContext } from 'react-router';
import apiClient from '@/lib/apiClient';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { AlertTriangle, BookOpen, Code, Eye, EyeOff, History, Loader2, RotateCcw, Save, Search, Wrench } from 'lucide-react';
import { SERVER_CONFIG_REFERENCE } from '@/config/serverConfigReference';
import ScenarioSelector from '@/components/ScenarioSelector';
import { useUnsavedChanges } from '@/context/UnsavedChangesContext';
import { configHistoryFrom, configHistoryTotalFrom, latestRevisionFrom } from './configHistory';
import { formatApiError } from '@/utils/errorMessages';
import ConfigLintPanel from './ConfigLintPanel';
import useConfirmDialog from '@/hooks/useConfirmDialog';

const PLATFORM_OPTIONS = ['PLATFORM_PC', 'PLATFORM_XBL', 'PLATFORM_PSN'];
const REDACTED_SENTINEL = '***';
const SECRET_CONFIG_PATHS = ['game.password', 'game.passwordAdmin', 'rcon.password'];
// Reference entries that live at the top level of the server document (not
// under `config`) — editing them in the wiki would write to the wrong place.
const RUNTIME_TOP_LEVEL_PATHS = new Set(['log_stats_enabled', 'max_fps', 'startup_parameters']);
// Reference value types the Config Wiki can edit inline with a small control.
const INLINE_EDITABLE_TYPES = new Set(['boolean', 'number', 'string', 'string list', 'identity list', 'enum list']);

function cloneConfig(value) { return JSON.parse(JSON.stringify(value || {})); }

function setDeepValue(root, path, nextValue) {
  const copy = cloneConfig(root);
  const parts = path.split('.');
  let cursor = copy;
  parts.forEach((part, index) => {
    if (index === parts.length - 1) cursor[part] = nextValue;
    else {
      if (!cursor[part] || typeof cursor[part] !== 'object' || Array.isArray(cursor[part])) cursor[part] = {};
      cursor = cursor[part];
    }
  });
  return copy;
}

function getDeepValue(root, path) {
  return path.split('.').reduce(
    (value, part) => (value && typeof value === 'object' ? value[part] : undefined),
    root,
  );
}

export function mergeSubmittedConfigSecrets(responseConfig, submittedConfig) {
  return SECRET_CONFIG_PATHS.reduce((merged, path) => (
    getDeepValue(merged, path) === REDACTED_SENTINEL
      ? setDeepValue(merged, path, getDeepValue(submittedConfig, path) ?? '')
      : merged
  ), ensureConfigShape(responseConfig));
}

function unsetDeepValue(root, path) {
  const copy = cloneConfig(root);
  const parts = path.split('.');
  let cursor = copy;
  for (let index = 0; index < parts.length - 1; index += 1) {
    const part = parts[index];
    if (!cursor[part] || typeof cursor[part] !== 'object' || Array.isArray(cursor[part])) return copy;
    cursor = cursor[part];
  }
  delete cursor[parts[parts.length - 1]];
  return copy;
}

function ensureConfigShape(config) {
  const next = cloneConfig(config);
  next.game = next.game || {};
  next.game.gameProperties = next.game.gameProperties || {};
  next.game.gameProperties.persistence = next.game.gameProperties.persistence || {};
  next.rcon = next.rcon || {};
  next.a2s = next.a2s || {};
  next.operating = next.operating || {};
  return next;
}

function parseConfigJson(value) {
  const parsed = JSON.parse(value || '{}');
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Config root must be a JSON object.');
  }
  return ensureConfigShape(parsed);
}

function parseListInput(value) { return String(value || '').split(/\r?\n|,/).map((item) => item.trim()).filter(Boolean); }
function formatListInput(values) { return Array.isArray(values) ? values.join('\n') : ''; }
function safeStringify(value) { return JSON.stringify(value || {}, null, 2); }
function normalizeRuntime(server) { return { log_stats_enabled: server?.log_stats_enabled !== false, max_fps: server?.max_fps ?? 120 }; }

function FieldShell({ label, help, children }) {
  return (
    <div className="space-y-2">
      <label className="text-xs font-medium text-mil-muted capitalize">{label}</label>
      {children}
      {help ? <p className="text-[11px] text-mil-dim">{help}</p> : null}
    </div>
  );
}

export function ServerPasswordInput({ label, value, onChange }) {
  const [revealed, setRevealed] = useState(false);
  const actionLabel = `${revealed ? 'Hide' : 'Show'} ${label}`;

  return (
    <div className="relative">
      <Input
        type={revealed ? 'text' : 'password'}
        value={value}
        onChange={onChange}
        aria-label={label}
        autoComplete="new-password"
        className="border-zinc-800 bg-mil-bg-deep/60 pr-11 text-white"
      />
      <button
        type="button"
        onClick={() => setRevealed((current) => !current)}
        aria-label={actionLabel}
        aria-pressed={revealed}
        title={actionLabel}
        className="absolute inset-y-0 right-0 flex w-11 items-center justify-center text-mil-dim transition-colors hover:text-brand-dark focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-dark"
      >
        {revealed ? <EyeOff className="h-4 w-4" aria-hidden="true" /> : <Eye className="h-4 w-4" aria-hidden="true" />}
      </button>
    </div>
  );
}

function ReadOnlyRow({ label, value, mono = false }) {
  return (
    <div className="flex items-center justify-between gap-4 rounded border border-zinc-800/70 bg-mil-bg-deep/40 px-3 py-2">
      <span className="text-xs text-mil-dim">{label}</span>
      <span className={`text-right text-sm text-mil-muted ${mono ? 'font-mono text-xs' : ''}`}>{value || 'N/A'}</span>
    </div>
  );
}

function formatCurrentValue(value) {
  if (Array.isArray(value)) return value.length ? value.join(', ') : '[]';
  if (value && typeof value === 'object') return JSON.stringify(value);
  if (value === '' || value === undefined || value === null) return null;
  return String(value);
}

function ReferenceCard({ item, value, onChange, onClear, onEditInForm }) {
  const inlineEditable = onChange != null && INLINE_EDITABLE_TYPES.has(item.type);
  const hasExplicit = value !== undefined && value !== null && value !== '';
  const display = formatCurrentValue(value);

  return (
    <Card className="border-zinc-800 bg-mil-bg-deep/40">
      <CardContent className="space-y-2 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-semibold text-white">{item.label}</span>
          <Badge variant="outline" className="border-zinc-700 text-[11px] text-mil-muted">{item.section}</Badge>
          <Badge variant="outline" className="border-zinc-700 text-[11px] text-mil-dim">{item.type}</Badge>
        </div>
        <div className="font-mono text-xs text-brand-dark">{item.path}</div>
        <p className="text-sm text-mil-muted">{item.description}</p>
        <div className="text-xs text-mil-dim">Default: {item.defaultValue}</div>
        {item.notes ? <p className="text-xs text-mil-dim">{item.notes}</p> : null}
        <div className="border-t border-zinc-800/70 pt-2">
          {inlineEditable ? (
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-3">
                <span className="text-xs text-mil-dim">{display !== null ? `Current: ${display}` : 'Unset — engine default'}</span>
                {hasExplicit ? (
                  <button type="button" onClick={onClear} className="text-[11px] text-amber-400/80 hover:text-amber-300">reset to default</button>
                ) : null}
              </div>
              {item.type === 'boolean' && (
                <div className="flex items-center gap-3">
                  <Switch checked={value !== false} onCheckedChange={onChange} />
                  <span className="text-xs text-zinc-500">{value === false ? 'Off' : 'On'}</span>
                </div>
              )}
              {item.type === 'number' && (
                <Input type="number" value={typeof value === 'number' ? value : ''} placeholder={item.defaultValue} onChange={(e) => onChange(Number.parseInt(e.target.value, 10))} className="h-8 border-zinc-800 bg-mil-bg-deep/60 text-xs text-white" />
              )}
              {item.type === 'string' && (
                <Input value={typeof value === 'string' ? value : ''} onChange={(e) => onChange(e.target.value)} className="h-8 border-zinc-800 bg-mil-bg-deep/60 text-xs text-white" />
              )}
              {(item.type === 'string list' || item.type === 'identity list' || item.type === 'enum list') && (
                <Textarea value={Array.isArray(value) ? value.join('\n') : ''} onChange={(e) => onChange(String(e.target.value || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean))} className="min-h-[72px] border-zinc-800 bg-mil-bg-deep/60 font-mono text-xs text-white" />
              )}
            </div>
          ) : (
            <div className="flex items-center justify-between gap-3">
              <span className="text-xs text-mil-dim">{display !== null ? `Current: ${display}` : (item.type === 'read only' ? 'Auto-managed' : 'Edit in the Form Editor')}</span>
              {item.type !== 'read only' && (
                <Button size="sm" variant="outline" type="button" onClick={onEditInForm} className="h-6 border-zinc-700 text-[11px] text-mil-muted">Edit in Form Editor</Button>
              )}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function ServerSettingsModule() {
  const { server, serverId, fetchServer, scenarioRefreshTrigger, user } = useOutletContext();
  const { registerDirtySource } = useUnsavedChanges();
  const serverRef = React.useRef(server);
  React.useEffect(() => { serverRef.current = server; }, [server]);
  const preserveJsonTextRef = React.useRef(false);
  // game.mods as this form loaded it. PUT /servers/{id} replaces the mod list
  // with config.game.mods, and mod deploys do not bump the config revision,
  // so saving settings used to put back whatever mods were loaded with the
  // form (or with a restored history revision).
  const loadedModsKeyRef = React.useRef('[]');
  const [config, setConfig] = useState(null);
  const [runtime, setRuntime] = useState(normalizeRuntime(server));
  const [configHistory, setConfigHistory] = useState([]);
  const [configHistoryTotal, setConfigHistoryTotal] = useState(0);
  // Concurrency token: the revision this editor was populated from. Sent back on
  // save so the backend can refuse a write that would clobber someone else.
  const [configRevision, setConfigRevision] = useState(null);
  const [conflict, setConflict] = useState(null);
  const [historyRestoring, setHistoryRestoring] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const [lintCounts, setLintCounts] = useState(null);
  const { confirm: confirmDialog, dialog: confirmDialogNode } = useConfirmDialog();
  const [diffOpen, setDiffOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [createBackup, setCreateBackup] = useState(true);
  const [activeTab, setActiveTab] = useState('form');
  const [jsonText, setJsonText] = useState('');
  const [jsonError, setJsonError] = useState(null);
  const [jsonDraftDirty, setJsonDraftDirty] = useState(false);
  const [referenceQuery, setReferenceQuery] = useState('');
  const [textEditors, setTextEditors] = useState({
    startupParameters: '',
    admins: '',
    rconBlacklist: '',
    rconWhitelist: '',
    navmeshProjects: '',
    missionHeader: '{}',
    persistenceDatabases: '{}',
    persistenceStorages: '{}',
  });
  const [jsonFieldErrors, setJsonFieldErrors] = useState({
    missionHeader: null,
    persistenceDatabases: null,
    persistenceStorages: null,
  });
  const [reconfigureNeeded, setReconfigureNeeded] = useState(false);
  const [reconfiguring, setReconfiguring] = useState(false);

  const initializeEditors = useCallback((nextConfig, nextServer) => {
    const safe = ensureConfigShape(nextConfig);
    loadedModsKeyRef.current = JSON.stringify(safe.game?.mods ?? []);
    setConfig(safe);
    setRuntime(normalizeRuntime(nextServer));
    setJsonText(safeStringify(safe));
    setJsonError(null);
    setJsonDraftDirty(false);
    setTextEditors({
      startupParameters: formatListInput(nextServer?.startup_parameters || []),
      admins: formatListInput(safe.game?.admins || []),
      rconBlacklist: formatListInput(safe.rcon?.blacklist || []),
      rconWhitelist: formatListInput(safe.rcon?.whitelist || []),
      navmeshProjects: formatListInput(Array.isArray(safe.operating?.disableNavmeshStreaming) ? safe.operating.disableNavmeshStreaming : []),
      missionHeader: safeStringify(safe.game?.gameProperties?.missionHeader || {}),
      persistenceDatabases: safeStringify(safe.game?.gameProperties?.persistence?.databases || {}),
      persistenceStorages: safeStringify(safe.game?.gameProperties?.persistence?.storages || {}),
    });
    setJsonFieldErrors({ missionHeader: null, persistenceDatabases: null, persistenceStorages: null });
  }, []);

  const markDirty = useCallback(() => { setDirty(true); setSaveError(null); }, []);
  const updateField = useCallback((path, value) => { setConfig((prev) => ensureConfigShape(setDeepValue(prev, path, value))); markDirty(); }, [markDirty]);
  const clearField = useCallback((path) => { setConfig((prev) => ensureConfigShape(unsetDeepValue(prev, path))); markDirty(); }, [markDirty]);
  const updateNumber = useCallback((path, value, fallback = 0) => {
    const numeric = Number.parseInt(value, 10);
    updateField(path, Number.isNaN(numeric) ? fallback : numeric);
  }, [updateField]);
  const updateListEditor = useCallback((editorKey, path, value) => {
    setTextEditors((prev) => ({ ...prev, [editorKey]: value }));
    updateField(path, parseListInput(value));
  }, [updateField]);
  const updateJsonEditor = useCallback((editorKey, path, value, emptyValue = {}) => {
    setTextEditors((prev) => ({ ...prev, [editorKey]: value }));
    try {
      const parsed = JSON.parse(value || '{}');
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        updateField(path, parsed);
        setJsonFieldErrors((prev) => ({ ...prev, [editorKey]: null }));
      } else setJsonFieldErrors((prev) => ({ ...prev, [editorKey]: 'Must be a JSON object.' }));
    } catch (error) {
      if (!value.trim()) {
        updateField(path, emptyValue);
        setJsonFieldErrors((prev) => ({ ...prev, [editorKey]: null }));
      } else setJsonFieldErrors((prev) => ({ ...prev, [editorKey]: error.message }));
    }
  }, [updateField]);

  /** Pull config + history fresh and repopulate the editors from that.
   *
   *  Shared by first mount and the conflict banner's "Reload theirs". The
   *  banner cannot reuse `discardConfigChanges`, which restores from the
   *  locally cached server — that copy predates the other operator's save, so
   *  it would restore the very version they just replaced. */
  const loadConfigFromServer = useCallback(() => {
    setLoading(true);
    const srv = serverRef.current;
    return Promise.allSettled([
      apiClient.get(`/servers/${serverId}/config`),
      apiClient.get(`/servers/${serverId}/config/history`),
    ]).then(([cfgRes, histRes]) => {
      if (cfgRes.status === 'fulfilled') {
        initializeEditors(cfgRes.value.data?.config || cfgRes.value.data || srv?.config || {}, srv);
      } else {
        initializeEditors(srv?.config || {}, srv);
      }
      if (histRes.status === 'fulfilled') {
        setConfigHistory(configHistoryFrom(histRes.value.data));
        setConfigHistoryTotal(configHistoryTotalFrom(histRes.value.data));
      } else {
        setConfigHistory([]);
        setConfigHistoryTotal(0);
      }
      // Prefer the config endpoint's own token; fall back to the history head so
      // the guard still engages if only one of the two calls succeeded. Left null
      // when neither did — sending a guessed token would be worse than not
      // guarding, because a wrong guess rejects a legitimate save.
      const loadedRevision = cfgRes.status === 'fulfilled' && Number.isInteger(cfgRes.value.data?.revision)
        ? cfgRes.value.data.revision
        : (histRes.status === 'fulfilled' ? latestRevisionFrom(histRes.value.data) : null);
      setConfigRevision(loadedRevision);
      setConflict(null);
      setDirty(false);
      setSaveError(null);
    }).finally(() => setLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initializeEditors, serverId]);

  useEffect(() => {
    loadConfigFromServer();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverId]);

  // Re-derive the "reconfigure required" notice from live container state so it
  // stays visible after a page reload — the post-save flag alone disappears the
  // moment the operator leaves the page. The health endpoint compares the
  // running container's max-FPS/RCON env against the saved values.
  useEffect(() => {
    let cancelled = false;
    apiClient.get(`/servers/${serverId}/rcon/health`)
      .then((res) => {
        if (!cancelled) setReconfigureNeeded(Boolean(res.data?.needs_reconfigure));
      })
      .catch(() => {});
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverId]);

  useEffect(() => {
    if (activeTab === 'json' && config && !jsonDraftDirty) {
      if (preserveJsonTextRef.current) {
        preserveJsonTextRef.current = false;
        return;
      }
      setJsonText(safeStringify(ensureConfigShape(config)));
      setJsonError(null);
    }
  }, [activeTab, config, jsonDraftDirty]);

  const jsonDraftState = useMemo(() => {
    if (!jsonDraftDirty) return { parsed: null, error: null };
    try {
      return { parsed: parseConfigJson(jsonText), error: null };
    } catch (error) {
      return { parsed: null, error: error.message };
    }
  }, [jsonDraftDirty, jsonText]);

  const handleJsonApply = useCallback(() => {
    try {
      const parsed = parseConfigJson(jsonText);
      initializeEditors(parsed, {
        ...serverRef.current,
        log_stats_enabled: runtime.log_stats_enabled,
        max_fps: runtime.max_fps,
        startup_parameters: parseListInput(textEditors.startupParameters),
      });
      markDirty();
      setJsonError(null);
    } catch (error) {
      setJsonError(error.message);
    }
  }, [initializeEditors, jsonText, markDirty, runtime.log_stats_enabled, runtime.max_fps, textEditors.startupParameters]);

  const handleRestoreHistory = useCallback(async (entry) => {
    setHistoryRestoring(entry?.version ?? 'legacy');
    setSaveError(null);
    try {
      let revisionConfig = entry?.config;
      if (!revisionConfig && entry?.version != null) {
        const detailRes = await apiClient.get(`/servers/${serverId}/config/history/${entry.version}`);
        revisionConfig = detailRes.data?.after_config;
      }
      if (!revisionConfig) throw new Error('This revision does not contain a restorable configuration.');
      initializeEditors(revisionConfig, serverRef.current);
      markDirty();
      setHistoryOpen(false);
    } catch (error) {
      setSaveError(formatApiError(error, error.message || 'Failed to load that configuration revision.'));
    } finally {
      setHistoryRestoring(null);
    }
  }, [initializeEditors, markDirty, serverId]);

  // Unless the operator edited mods in this form on purpose, send the mod
  // list that is deployed right now rather than the one loaded with the form.
  const withDeployedMods = useCallback(async (cfg) => {
    if (JSON.stringify(cfg?.game?.mods ?? []) !== loadedModsKeyRef.current) return cfg;
    const res = await apiClient.get(`/servers/${serverId}/config`);
    const latest = res.data?.config?.game?.mods ?? res.data?.game?.mods ?? serverRef.current?.mods;
    if (!Array.isArray(latest)) return cfg;
    return { ...cfg, game: { ...(cfg.game || {}), mods: latest } };
  }, [serverId]);

  const saveConfig = useCallback(async () => {
    if (Object.values(jsonFieldErrors).some(Boolean)) {
      setSaveError('Resolve the JSON field errors before saving.');
      return false;
    }

    let configToSave = config;
    if (jsonDraftDirty) {
      if (jsonDraftState.error || !jsonDraftState.parsed) {
        setJsonError(jsonDraftState.error || 'Fix the Raw JSON editor before saving.');
        setSaveError('Resolve the Raw JSON editor errors before saving.');
        return false;
      }
      configToSave = jsonDraftState.parsed;
      setJsonError(null);
    }

    // The config check is advisory, never a hard block: the operator may know better
    // than the rule set, but has to say so.
    if (lintCounts?.error && !(await confirmDialog({
      title: 'Save a config with errors?',
      description: `The config check found ${lintCounts.error} error(s) that can stop the server from starting. Open the config check above to see them.`,
      confirmLabel: 'Save anyway',
      destructive: true,
    }))) {
      return false;
    }

    setSaving(true);
    setSaveError(null);
    setReconfigureNeeded(false);
    try {
      const rawJsonText = jsonText;
      configToSave = await withDeployedMods(configToSave);
      if (createBackup) {
        await apiClient.post(`/servers/${serverId}/backups`, null, {
          validateStatus: (status) => status < 400,
        });
      }
      const updatePayload = {
        config: configToSave,
        log_stats_enabled: runtime.log_stats_enabled,
        max_fps: Math.max(30, parseInt(runtime.max_fps, 10) || 120),
        startup_parameters: parseListInput(textEditors.startupParameters),
        // Omitted when unknown: the backend treats a missing token as
        // last-write-wins, which is the old behaviour rather than a hard failure.
        ...(Number.isInteger(configRevision) ? { base_revision: configRevision } : {}),
      };
      const res = await apiClient.put(`/servers/${serverId}`, updatePayload, {
        validateStatus: (s) => s < 400,
      });
      // General server responses intentionally redact passwords. Keep every
      // backend-normalized field, but do not let those response sentinels
      // replace the exact secrets the operator just submitted in editor state.
      const nextConfig = mergeSubmittedConfigSecrets(res.data?.config || configToSave, configToSave);
      if (jsonDraftDirty) {
        preserveJsonTextRef.current = true;
      }
      initializeEditors(nextConfig, res.data || serverRef.current);
      if (jsonDraftDirty) {
        setJsonText(rawJsonText);
        setJsonDraftDirty(false);
        setJsonError(null);
      }
      const historyRes = await apiClient.get(`/servers/${serverId}/config/history`).catch(() => null);
      setConfigHistory(configHistoryFrom(historyRes?.data));
      setConfigHistoryTotal(configHistoryTotalFrom(historyRes?.data));
      // Advance the token to what we just wrote, so a second save in the same
      // sitting is not rejected as stale by our own previous save.
      if (historyRes) setConfigRevision(latestRevisionFrom(historyRes.data));
      setConflict(null);
      setDirty(false);
      if (res.data?.needs_reconfigure) {
        setReconfigureNeeded(true);
      }
      await fetchServer(true);
      return true;
    } catch (error) {
      // 409 means someone saved while this form was open. Keep the operator's
      // edits on screen — discarding them here is exactly the data loss the
      // guard exists to prevent — and let them reload deliberately.
      if (error.response?.status === 409) {
        const detail = error.response.data?.detail || {};
        setConflict({
          changedBy: detail.changed_by || 'another operator',
          changedAt: detail.changed_at || '',
          currentRevision: detail.current_revision ?? null,
        });
        setSaveError(null);
        return false;
      }
      const detail = error.response?.data?.detail;
      // Never hand a non-string straight to state: FastAPI validation errors
      // arrive as objects/arrays, and rendering one throws.
      setSaveError(
        typeof detail === 'string'
          ? detail
          : (!error.response && error.message) || 'Failed to save server configuration.',
      );
      return false;
    } finally {
      setSaving(false);
    }
  }, [config, configRevision, createBackup, fetchServer, initializeEditors, jsonDraftDirty, jsonDraftState.error, jsonDraftState.parsed, jsonFieldErrors, lintCounts, confirmDialog, runtime.log_stats_enabled, runtime.max_fps, serverId, textEditors.startupParameters, user, withDeployedMods]);

  const discardConfigChanges = useCallback(() => {
    initializeEditors(serverRef.current?.config || {}, serverRef.current);
    setDirty(false);
    setSaveError(null);
  }, [initializeEditors]);

  useEffect(() => registerDirtySource({
    id: 'server-settings-config',
    label: jsonDraftDirty ? 'Server settings raw JSON draft' : 'Server settings',
    summary: jsonDraftDirty ? 'Raw JSON draft pending save' : 'Configuration fields pending save',
    dirty: dirty || jsonDraftDirty,
    onSave: saveConfig,
    onDiscard: discardConfigChanges,
    onSaved: () => {
      setDirty(false);
      setJsonDraftDirty(false);
      setSaveError(null);
    },
  }), [dirty, discardConfigChanges, jsonDraftDirty, registerDirtySource, saveConfig, serverId]);

  const handleReconfigure = useCallback(async () => {
    setReconfiguring(true);
    try {
      await apiClient.post(`/servers/${serverId}/reconfigure`, null, {
        validateStatus: (s) => s < 400,
      });
      setReconfigureNeeded(false);
      await fetchServer(true);
    } catch (error) {
      setSaveError(formatApiError(error, 'Reconfigure failed.'));
    } finally {
      setReconfiguring(false);
    }
  }, [serverId, fetchServer, user]);

  const safeConfig = ensureConfigShape(config || {});
  const previewConfig = jsonDraftState.parsed || safeConfig;
  const game = safeConfig.game;
  const gameProps = safeConfig.game.gameProperties;
  const persistence = safeConfig.game.gameProperties.persistence || {};
  const persistenceEnabled = persistence.loadSessionSave !== false;
  const rcon = safeConfig.rcon;
  const a2s = safeConfig.a2s;
  const operating = safeConfig.operating;

  const filteredReference = useMemo(() => {
    const query = referenceQuery.trim().toLowerCase();
    if (!query) return SERVER_CONFIG_REFERENCE;
    return SERVER_CONFIG_REFERENCE.filter((item) => `${item.section} ${item.label} ${item.path} ${item.description} ${item.notes || ''}`.toLowerCase().includes(query));
  }, [referenceQuery]);
  const groupedReference = useMemo(() => filteredReference.reduce((acc, item) => {
    if (!acc[item.section]) acc[item.section] = [];
    acc[item.section].push(item);
    return acc;
  }, {}), [filteredReference]);

  if (loading) return <div className="flex items-center justify-center py-16"><Loader2 className="h-6 w-6 animate-spin text-brand" /></div>;

  return (
    <form className="space-y-6" onSubmit={(e) => e.preventDefault()}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold tracking-wider text-mil-muted" style={{ fontFamily: "var(--font-heading)" }}>
            Server Settings
          </h2>
          <p className="mt-1 text-xs text-mil-dim">
            Reforger runtime, JSON config, and the field reference live together here.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {dirty ? <Badge variant="outline" className="border-amber-600/30 text-xs text-amber-400">Unsaved</Badge> : null}
          <Button type="button" size="sm" variant="outline" onClick={() => setHistoryOpen(true)} className="h-7 border-zinc-800 text-xs text-mil-muted">
            <History className="mr-1 h-3 w-3" /> History ({configHistoryTotal})
          </Button>
          <Button type="button" size="sm" variant="outline" onClick={() => setDiffOpen(true)} className="h-7 border-zinc-800 text-xs text-mil-muted">
            <Eye className="mr-1 h-3 w-3" /> Preview
          </Button>
          <Button type="button" size="sm" onClick={saveConfig} disabled={!dirty || saving} className="h-7 bg-brand text-xs text-black hover:bg-brand-light">
            {saving ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <Save className="mr-1 h-3 w-3" />}
            Save
          </Button>
        </div>
      </div>

      <div className="rounded border border-amber-600/30 bg-amber-600/5 px-3 py-2 text-xs text-amber-400">
        New servers start with the minimum dashboard-ready config. Optional gameplay, persistence, and operating overrides stay effectively unset until you change them here. Host IPs, Docker mounts, and allocated ports remain backend-managed so users cannot break provisioning.
      </div>

      <div className="flex items-center gap-2 text-xs text-mil-dim">
        <Switch checked={createBackup} onCheckedChange={setCreateBackup} className="h-4 w-7" />
        Create rollback point before saving
      </div>

      {saveError ? (
        <div className="rounded border border-red-600/30 bg-red-600/10 px-3 py-2 text-xs text-red-400">
          {saveError}
        </div>
      ) : null}

      {confirmDialogNode}
      {config ? (
        <ConfigLintPanel
          serverId={serverId}
          draft={jsonDraftDirty && jsonDraftState.parsed ? jsonDraftState.parsed : config}
          onCounts={setLintCounts}
        />
      ) : null}

      {conflict ? (
        <div
          role="alert"
          className="flex flex-wrap items-start gap-2 rounded border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-300"
        >
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <p className="font-semibold">
              {conflict.changedBy} saved this config while you were editing.
            </p>
            <p className="mt-0.5 text-amber-200/90">
              Nothing was overwritten and your edits are still here
              {conflict.changedAt ? ` — their change landed ${new Date(conflict.changedAt).toLocaleString()}` : ''}.
              Reload to pick up their version, then reapply yours. Check History
              first if you want to see what they changed.
            </p>
          </div>
          <Button type="button"
            size="sm"
            variant="outline"
            onClick={() => { setConflict(null); setHistoryOpen(true); }}
            className="h-7 border-amber-500/40 text-[11px] text-amber-200 hover:bg-amber-500/10"
          >
            View history
          </Button>
          <Button type="button"
            size="sm"
            onClick={() => { setConflict(null); loadConfigFromServer(); }}
            className="h-7 bg-amber-500 text-[11px] text-black hover:bg-amber-400"
          >
            Reload theirs
          </Button>
        </div>
      ) : null}

      {reconfigureNeeded ? (
        <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-md border-2 border-amber-500/70 bg-amber-500/15 px-4 py-3 text-sm text-amber-100">
          <div className="flex items-center gap-3">
            <AlertTriangle className="h-5 w-5 shrink-0 text-amber-400" aria-hidden="true" />
            <div>
              <p className="font-semibold text-amber-100">Action required — reconfigure this server</p>
              <p className="mt-0.5 text-xs text-amber-200/80">
                Your max FPS, RCON, or startup-parameter changes are saved but not yet applied to the running container. A normal restart will NOT pick them up — you must reconfigure to recreate the container.
              </p>
            </div>
          </div>
          <Button type="button" size="sm" onClick={handleReconfigure} disabled={reconfiguring} className="h-8 whitespace-nowrap bg-amber-600 text-xs font-semibold text-white hover:bg-amber-500">
            {reconfiguring ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <RotateCcw className="mr-1 h-3 w-3" />}
            Reconfigure Now
          </Button>
        </div>
      ) : null}

      <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-4">
        <TabsList className="grid w-full grid-cols-3 bg-mil-bg-deep/60">
          <TabsTrigger value="form" className="text-xs"><Wrench className="mr-1 h-3 w-3" /> Form Editor</TabsTrigger>
          <TabsTrigger value="reference" className="text-xs"><BookOpen className="mr-1 h-3 w-3" /> Config Wiki</TabsTrigger>
          <TabsTrigger value="json" className="text-xs"><Code className="mr-1 h-3 w-3" /> Raw JSON</TabsTrigger>
        </TabsList>

        <TabsContent value="form" className="space-y-4">
          <fieldset disabled={saving} className={saving ? 'opacity-60 pointer-events-none' : ''}>
          <div className="grid gap-4 xl:grid-cols-2">
            <Card className="border-zinc-800 bg-mil-bg-deep/60">
              <CardHeader className="pb-2">
                <CardTitle className="text-xs font-semibold tracking-wider text-mil-muted">RCON & TELEMETRY</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <FieldShell label="Enable logStats" help="Needed for FPS metrics and richer diagnostics.">
                  <div className="flex items-center justify-between rounded border border-zinc-800 bg-mil-bg-deep/40 px-3 py-2">
                    <span className="text-sm text-mil-muted">Collect engine performance stats in the log</span>
                    <Switch checked={runtime.log_stats_enabled} onCheckedChange={(value) => { setRuntime((prev) => ({ ...prev, log_stats_enabled: value })); markDirty(); }} />
                  </div>
                </FieldShell>
                <FieldShell label="Max FPS" help="Bohemia recommends limiting max FPS for public hosts.">
                  <Input type="number" min={30} max={240} value={runtime.max_fps} onChange={(e) => { setRuntime((prev) => ({ ...prev, max_fps: parseInt(e.target.value, 10) || 120 })); markDirty(); }} className="border-zinc-800 bg-mil-bg-deep/60 text-white" />
                </FieldShell>
                <FieldShell label="Extra Startup Parameters" help="One parameter per line for advanced launch flags.">
                  <Textarea value={textEditors.startupParameters} onChange={(e) => { setTextEditors((prev) => ({ ...prev, startupParameters: e.target.value })); markDirty(); }} className="min-h-[120px] border-zinc-800 bg-mil-bg-deep/60 font-mono text-xs text-white" placeholder="-profileVerbose" />
                </FieldShell>
              </CardContent>
            </Card>

            <Card className="border-zinc-800 bg-mil-bg-deep/60">
              <CardHeader className="pb-2">
                <CardTitle className="text-xs font-semibold tracking-wider text-mil-muted">CORE SERVER</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <FieldShell label="In-Game Server Name" help="The name shown in the Arma Reforger server browser. Not the dashboard display name.">
                  <Input value={game.name || ''} onChange={(e) => updateField('game.name', e.target.value)} className="border-zinc-800 bg-mil-bg-deep/60 text-white" />
                </FieldShell>
                <FieldShell label="Join Password">
                  <ServerPasswordInput label="Join Password" value={game.password || ''} onChange={(e) => updateField('game.password', e.target.value)} />
                </FieldShell>
                <FieldShell label="Admin Password" help="This password must not contain spaces.">
                  <ServerPasswordInput label="Admin Password" value={game.passwordAdmin || ''} onChange={(e) => updateField('game.passwordAdmin', e.target.value)} />
                </FieldShell>
                <FieldShell label="Scenario ID" help="Select a vanilla, shared, or mod-provided scenario, or add a server-only one below.">
                  <ScenarioSelector value={game.scenarioId || ''} onChange={(val) => updateField('game.scenarioId', val)} serverId={serverId} refreshTrigger={scenarioRefreshTrigger} />
                </FieldShell>
                <div className="grid gap-4 sm:grid-cols-2">
                  <FieldShell label="Max Players">
                    <Input type="number" value={game.maxPlayers ?? 32} onChange={(e) => updateNumber('game.maxPlayers', e.target.value, 32)} className="border-zinc-800 bg-mil-bg-deep/60 text-white" />
                  </FieldShell>
                  <FieldShell label="Mods Required By Default">
                    <div className="flex items-center justify-between rounded border border-zinc-800 bg-mil-bg-deep/40 px-3 py-2">
                      <span className="text-sm text-mil-muted">Require client mods by default</span>
                      <Switch checked={game.modsRequiredByDefault !== false} onCheckedChange={(value) => updateField('game.modsRequiredByDefault', value)} />
                    </div>
                  </FieldShell>
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  <FieldShell label="Visible">
                    <div className="flex items-center justify-between rounded border border-zinc-800 bg-mil-bg-deep/40 px-3 py-2">
                      <span className="text-sm text-mil-muted">Show in server browser</span>
                      <Switch checked={game.visible !== false} onCheckedChange={(value) => updateField('game.visible', value)} />
                    </div>
                  </FieldShell>
                  <FieldShell label="Cross Platform">
                    <div className="flex items-center justify-between rounded border border-zinc-800 bg-mil-bg-deep/40 px-3 py-2">
                      <span className="text-sm text-mil-muted">Accept all supported platforms</span>
                      <Switch checked={game.crossPlatform === true} onCheckedChange={(value) => updateField('game.crossPlatform', value)} />
                    </div>
                  </FieldShell>
                </div>
                <FieldShell label="Supported Platforms" help="Explicit PC, Xbox, and PlayStation allow-list.">
                  <div className="flex flex-wrap gap-2">
                    {PLATFORM_OPTIONS.map((platform) => {
                      const selected = (game.supportedPlatforms || []).includes(platform);
                      return (
                        <button
                          key={platform}
                          type="button"
                          onClick={() => {
                            const current = Array.isArray(game.supportedPlatforms) ? [...game.supportedPlatforms] : [];
                            const next = selected ? current.filter((value) => value !== platform) : [...current, platform];
                            updateField('game.supportedPlatforms', next);
                          }}
                          className={`rounded border px-3 py-2 text-xs ${selected ? 'border-brand/30 bg-brand/10 text-brand' : 'border-zinc-800 bg-mil-bg-deep/40 text-mil-muted'}`}
                        >
                          {platform}
                        </button>
                      );
                    })}
                  </div>
                </FieldShell>
                <FieldShell label="Listed Admins" help="One IdentityId or SteamId per line.">
                  <Textarea value={textEditors.admins} onChange={(e) => updateListEditor('admins', 'game.admins', e.target.value)} className="min-h-[110px] border-zinc-800 bg-mil-bg-deep/60 font-mono text-xs text-white" />
                </FieldShell>
              </CardContent>
            </Card>

            <Card className="border-zinc-800 bg-mil-bg-deep/60">
              <CardHeader className="pb-2">
                <CardTitle className="text-xs font-semibold tracking-wider text-mil-muted">OPTIONAL GAMEPLAY</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <p className="text-xs text-mil-dim">
                  These overrides are not pre-filled into new server configs. Leave them untouched to keep the deployed JSON minimal.
                </p>
                <div className="grid gap-4 sm:grid-cols-2">
                  <FieldShell label="Max View Distance">
                    <Input type="number" value={gameProps.serverMaxViewDistance ?? 2500} onChange={(e) => updateNumber('game.gameProperties.serverMaxViewDistance', e.target.value, 2500)} className="border-zinc-800 bg-mil-bg-deep/60 text-white" />
                  </FieldShell>
                  <FieldShell label="Min Grass Distance">
                    <Input type="number" value={gameProps.serverMinGrassDistance ?? 50} onChange={(e) => updateNumber('game.gameProperties.serverMinGrassDistance', e.target.value, 50)} className="border-zinc-800 bg-mil-bg-deep/60 text-white" />
                  </FieldShell>
                  <FieldShell label="Network View Distance">
                    <Input type="number" value={gameProps.networkViewDistance ?? 1000} onChange={(e) => updateNumber('game.gameProperties.networkViewDistance', e.target.value, 1000)} className="border-zinc-800 bg-mil-bg-deep/60 text-white" />
                  </FieldShell>
                </div>
                <FieldShell label="Third Person View" help="DISABLE forces first-person only · ENABLE allows third person everywhere · ENABLE_DRIVER_ONLY limits third person to the vehicle driver. Leave unset to use the engine default (third person enabled).">
                  <div className="flex flex-wrap gap-2">
                    {[
                      ['DISABLE', 'Disabled'],
                      ['ENABLE', 'Enabled'],
                      ['ENABLE_DRIVER_ONLY', 'Driver Only'],
                    ].map(([value, optionLabel]) => {
                      const selected = gameProps.disableThirdPerson === value;
                      return (
                        <button
                          key={value}
                          type="button"
                          onClick={() => (selected ? clearField('game.gameProperties.disableThirdPerson') : updateField('game.gameProperties.disableThirdPerson', value))}
                          className={`rounded border px-3 py-2 text-xs ${selected ? 'border-brand/30 bg-brand/10 text-brand' : 'border-zinc-800 bg-mil-bg-deep/40 text-mil-muted'}`}
                        >
                          {optionLabel}
                        </button>
                      );
                    })}
                  </div>
                </FieldShell>
                <div className="grid gap-4 sm:grid-cols-2">
                  {[
                    ['Fast Validation', 'game.gameProperties.fastValidation', gameProps.fastValidation !== false],
                    ['BattlEye', 'game.gameProperties.battlEye', gameProps.battlEye !== false],
                    ['Disable VON UI', 'game.gameProperties.VONDisableUI', !!gameProps.VONDisableUI],
                    ['Disable Direct Speech UI', 'game.gameProperties.VONDisableDirectSpeechUI', !!gameProps.VONDisableDirectSpeechUI],
                    ['Cross-Faction Radio', 'game.gameProperties.VONCanTransmitCrossFaction', !!gameProps.VONCanTransmitCrossFaction],
                  ].map(([label, path, checked]) => (
                    <FieldShell key={path} label={label}>
                      <div className="flex items-center justify-between rounded border border-zinc-800 bg-mil-bg-deep/40 px-3 py-2">
                        <span className="text-sm text-mil-muted">{label}</span>
                        <Switch checked={checked} onCheckedChange={(value) => updateField(path, value)} />
                      </div>
                    </FieldShell>
                  ))}
                </div>
                <FieldShell label="Mission Header Override" help="JSON object for scenario metadata, time, weather, and conflict-specific tuning.">
                  <Textarea value={textEditors.missionHeader} onChange={(e) => updateJsonEditor('missionHeader', 'game.gameProperties.missionHeader', e.target.value, {})} className="min-h-[180px] border-zinc-800 bg-mil-bg-deep/60 font-mono text-xs text-white" />
                  {jsonFieldErrors.missionHeader ? <p className="text-xs text-red-400">{jsonFieldErrors.missionHeader}</p> : null}
                </FieldShell>
              </CardContent>
            </Card>

            <Card className="border-zinc-800 bg-mil-bg-deep/60">
              <CardHeader className="pb-2">
                <CardTitle className="text-xs font-semibold tracking-wider text-mil-muted">RCON</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <FieldShell label="RCON Password">
                  <ServerPasswordInput label="RCON Password" value={rcon.password || ''} onChange={(e) => updateField('rcon.password', e.target.value)} />
                </FieldShell>
                <div className="grid gap-4 sm:grid-cols-2">
                  <FieldShell label="Permission">
                    <div className="flex gap-2">
                      {['admin', 'monitor'].map((value) => (
                        <button
                          key={value}
                          type="button"
                          onClick={() => updateField('rcon.permission', value)}
                          className={`rounded border px-3 py-2 text-xs ${(rcon.permission || 'admin') === value ? 'border-brand/30 bg-brand/10 text-brand' : 'border-zinc-800 bg-mil-bg-deep/40 text-mil-muted'}`}
                        >
                          {value}
                        </button>
                      ))}
                    </div>
                  </FieldShell>
                  <FieldShell label="Max Clients">
                    <Input type="number" value={rcon.maxClients ?? 16} onChange={(e) => updateNumber('rcon.maxClients', e.target.value, 16)} className="border-zinc-800 bg-mil-bg-deep/60 text-white" />
                  </FieldShell>
                </div>
                <FieldShell label="Blacklist" help="One blocked command per line.">
                  <Textarea value={textEditors.rconBlacklist} onChange={(e) => updateListEditor('rconBlacklist', 'rcon.blacklist', e.target.value)} className="min-h-[100px] border-zinc-800 bg-mil-bg-deep/60 font-mono text-xs text-white" />
                </FieldShell>
                <FieldShell label="Whitelist" help="If populated, only these commands may run.">
                  <Textarea value={textEditors.rconWhitelist} onChange={(e) => updateListEditor('rconWhitelist', 'rcon.whitelist', e.target.value)} className="min-h-[100px] border-zinc-800 bg-mil-bg-deep/60 font-mono text-xs text-white" />
                </FieldShell>
              </CardContent>
            </Card>

            <Card className="border-zinc-800 bg-mil-bg-deep/60">
              <CardHeader className="pb-2">
                <CardTitle className="text-xs font-semibold tracking-wider text-mil-muted">PERSISTENCE</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <p className="text-xs text-mil-dim">
                  Persistence is written to <span className="font-mono">game.gameProperties.persistence</span> (the path the engine reads). New servers ship with it OFF. With persistence off the server starts fresh every launch and never restores the previous save.
                </p>
                <FieldShell label="Enable Persistence" help="Off = loadSessionSave:false + autoSaveInterval:0, so saves are never created or restored.">
                  <div className="flex items-center justify-between rounded border border-zinc-800 bg-mil-bg-deep/40 px-3 py-2">
                    <span className="text-sm text-mil-muted">{persistenceEnabled ? 'Enabled — saves load on launch' : 'Disabled — fresh start each launch'}</span>
                    <Switch
                      checked={persistenceEnabled}
                      onCheckedChange={(value) => {
                        if (value) {
                          updateField('game.gameProperties.persistence.loadSessionSave', true);
                          updateField('game.gameProperties.persistence.keepSessionSave', false);
                          if (!persistence.autoSaveInterval) updateField('game.gameProperties.persistence.autoSaveInterval', 10);
                        } else {
                          updateField('game.gameProperties.persistence.loadSessionSave', false);
                          updateField('game.gameProperties.persistence.autoSaveInterval', 0);
                          updateField('game.gameProperties.persistence.keepSessionSave', false);
                        }
                      }}
                    />
                  </div>
                </FieldShell>
                <div className="grid gap-4 sm:grid-cols-2" style={persistenceEnabled ? undefined : { opacity: 0.5 }}>
                  <FieldShell label="Auto Save Interval" help="Minutes between autosaves (0–60). 0 disables autosave.">
                    <Input type="number" min={0} max={60} disabled={!persistenceEnabled} value={persistence.autoSaveInterval ?? 10} onChange={(e) => updateNumber('game.gameProperties.persistence.autoSaveInterval', e.target.value, 10)} className="border-zinc-800 bg-mil-bg-deep/60 text-white" />
                  </FieldShell>
                  <FieldShell label="Save Retention" help="Number of save points to keep (1–128).">
                    <Input type="number" min={1} max={128} disabled={!persistenceEnabled} value={persistence.saveRetention ?? 10} onChange={(e) => updateNumber('game.gameProperties.persistence.saveRetention', e.target.value, 10)} className="border-zinc-800 bg-mil-bg-deep/60 text-white" />
                  </FieldShell>
                  <FieldShell label="Keep Session Save" help="Keep save points after the mission finishes.">
                    <div className="flex items-center justify-between rounded border border-zinc-800 bg-mil-bg-deep/40 px-3 py-2">
                      <span className="text-sm text-mil-muted">{persistence.keepSessionSave ? 'Yes' : 'No'}</span>
                      <Switch checked={!!persistence.keepSessionSave} disabled={!persistenceEnabled} onCheckedChange={(value) => updateField('game.gameProperties.persistence.keepSessionSave', value)} />
                    </div>
                  </FieldShell>
                  <FieldShell label="Hive ID" help="Separates save UUIDs when servers share one database (0–16383).">
                    <Input type="number" min={0} max={16383} disabled={!persistenceEnabled} value={persistence.hiveId ?? 0} onChange={(e) => updateNumber('game.gameProperties.persistence.hiveId', e.target.value, 0)} className="border-zinc-800 bg-mil-bg-deep/60 text-white" />
                  </FieldShell>
                </div>
                <FieldShell label="Database Overrides" help="JSON object keyed by persistence database name.">
                  <Textarea disabled={!persistenceEnabled} value={textEditors.persistenceDatabases} onChange={(e) => updateJsonEditor('persistenceDatabases', 'game.gameProperties.persistence.databases', e.target.value, {})} className="min-h-[150px] border-zinc-800 bg-mil-bg-deep/60 font-mono text-xs text-white" />
                  {jsonFieldErrors.persistenceDatabases ? <p className="text-xs text-red-400">{jsonFieldErrors.persistenceDatabases}</p> : null}
                </FieldShell>
                <FieldShell label="Storage Overrides" help="JSON object keyed by storage name.">
                  <Textarea disabled={!persistenceEnabled} value={textEditors.persistenceStorages} onChange={(e) => updateJsonEditor('persistenceStorages', 'game.gameProperties.persistence.storages', e.target.value, {})} className="min-h-[150px] border-zinc-800 bg-mil-bg-deep/60 font-mono text-xs text-white" />
                  {jsonFieldErrors.persistenceStorages ? <p className="text-xs text-red-400">{jsonFieldErrors.persistenceStorages}</p> : null}
                </FieldShell>
              </CardContent>
            </Card>

            <Card className="border-zinc-800 bg-mil-bg-deep/60">
              <CardHeader className="pb-2">
                <CardTitle className="text-xs font-semibold tracking-wider text-mil-muted">OPTIONAL OPERATING</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <p className="text-xs text-mil-dim">
                  Operating overrides are advanced host-level controls. Leave them at engine defaults unless you are solving a specific gameplay or performance problem.
                </p>
                <div className="grid gap-4 sm:grid-cols-2">
                  {[
                    ['Lobby Player Synchronise', 'operating.lobbyPlayerSynchronise', operating.lobbyPlayerSynchronise !== false],
                    ['Disable Crash Reporter', 'operating.disableCrashReporter', !!operating.disableCrashReporter],
                    ['Disable Server Shutdown', 'operating.disableServerShutdown', !!operating.disableServerShutdown],
                    ['Disable AI', 'operating.disableAI', !!operating.disableAI],
                  ].map(([label, path, checked]) => (
                    <FieldShell key={path} label={label}>
                      <div className="flex items-center justify-between rounded border border-zinc-800 bg-mil-bg-deep/40 px-3 py-2">
                        <span className="text-sm text-mil-muted">{label}</span>
                        <Switch checked={checked} onCheckedChange={(value) => updateField(path, value)} />
                      </div>
                    </FieldShell>
                  ))}
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  <FieldShell label="Player Save Time">
                    <Input type="number" value={operating.playerSaveTime ?? 120} onChange={(e) => updateNumber('operating.playerSaveTime', e.target.value, 120)} className="border-zinc-800 bg-mil-bg-deep/60 text-white" />
                  </FieldShell>
                  <FieldShell label="AI Limit">
                    <Input type="number" value={operating.aiLimit ?? -1} onChange={(e) => updateNumber('operating.aiLimit', e.target.value, -1)} className="border-zinc-800 bg-mil-bg-deep/60 text-white" />
                  </FieldShell>
                  <FieldShell label="Slot Reservation Timeout">
                    <Input type="number" value={operating.slotReservationTimeout ?? 60} onChange={(e) => updateNumber('operating.slotReservationTimeout', e.target.value, 60)} className="border-zinc-800 bg-mil-bg-deep/60 text-white" />
                  </FieldShell>
                  <FieldShell label="Join Queue Size">
                    <Input type="number" value={operating.joinQueue?.maxSize ?? 0} onChange={(e) => updateNumber('operating.joinQueue.maxSize', e.target.value, 0)} className="border-zinc-800 bg-mil-bg-deep/60 text-white" />
                  </FieldShell>
                </div>
                <FieldShell label="Disable Navmesh Streaming" help="Use engine default, disable all, or list project names one per line.">
                  <div className="flex flex-wrap gap-2">
                    <Button type="button" size="sm" variant="outline" className="border-zinc-800 text-xs text-mil-muted" onClick={() => { clearField('operating.disableNavmeshStreaming'); setTextEditors((prev) => ({ ...prev, navmeshProjects: '' })); }}>
                      Use engine default
                    </Button>
                    <Button type="button" size="sm" variant="outline" className="border-zinc-800 text-xs text-mil-muted" onClick={() => { updateField('operating.disableNavmeshStreaming', []); setTextEditors((prev) => ({ ...prev, navmeshProjects: '' })); }}>
                      Disable all navmeshes
                    </Button>
                  </div>
                  <Textarea
                    value={textEditors.navmeshProjects}
                    onChange={(e) => {
                      const value = e.target.value;
                      setTextEditors((prev) => ({ ...prev, navmeshProjects: value }));
                      const parsed = parseListInput(value);
                      if (parsed.length > 0) updateField('operating.disableNavmeshStreaming', parsed);
                      else clearField('operating.disableNavmeshStreaming');
                    }}
                    className="min-h-[110px] border-zinc-800 bg-mil-bg-deep/60 font-mono text-xs text-white"
                    placeholder="Soldiers&#10;BTRlike"
                  />
                </FieldShell>
              </CardContent>
            </Card>

            <Card className="border-zinc-800 bg-mil-bg-deep/60 xl:col-span-2">
              <CardHeader className="pb-2">
                <CardTitle className="text-xs font-semibold tracking-wider text-mil-muted">BACKEND-MANAGED NETWORK BINDINGS</CardTitle>
              </CardHeader>
              <CardContent className="grid gap-3 lg:grid-cols-2">
                <ReadOnlyRow label="Bind Address" value={safeConfig.bindAddress || '0.0.0.0'} mono />
                <ReadOnlyRow label="Game Port" value={String(safeConfig.bindPort || '')} mono />
                <ReadOnlyRow label="Public Address" value={safeConfig.publicAddress || safeConfig.bindAddress || '0.0.0.0'} mono />
                <ReadOnlyRow label="Public Port" value={String(safeConfig.publicPort || '')} mono />
                <ReadOnlyRow label="A2S Address" value={a2s.address || '0.0.0.0'} mono />
                <ReadOnlyRow label="A2S Port" value={String(a2s.port || '')} mono />
                <ReadOnlyRow label="RCON Address" value={rcon.address || '0.0.0.0'} mono />
                <ReadOnlyRow label="RCON Port" value={String(rcon.port || '')} mono />
              </CardContent>
            </Card>
          </div>
          </fieldset>
        </TabsContent>

        <TabsContent value="reference" className="space-y-4">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-mil-dim" />
            <Input value={referenceQuery} onChange={(e) => setReferenceQuery(e.target.value)} placeholder="Search the Reforger config reference..." className="border-zinc-800 bg-mil-bg-deep/60 pl-10 text-white placeholder:text-mil-dim" />
          </div>
          <div className="space-y-5">
            {Object.keys(groupedReference).length === 0 ? (
              <Card className="border-zinc-800 bg-mil-bg-deep/60">
                <CardContent className="py-10 text-center text-sm text-mil-dim">No config reference entries match that search.</CardContent>
              </Card>
            ) : Object.entries(groupedReference).map(([section, items]) => (
              <div key={section} className="space-y-3">
                <div className="text-xs font-medium text-mil-muted capitalize">{section}</div>
                <div className="grid gap-3 xl:grid-cols-2">
                  {items.map((item) => {
                  const canInline = INLINE_EDITABLE_TYPES.has(item.type)
                    && !SECRET_CONFIG_PATHS.includes(item.path)
                    && !RUNTIME_TOP_LEVEL_PATHS.has(item.path)
                    && !item.path.includes('[');
                  return (
                    <ReferenceCard
                      key={item.path}
                      item={item}
                      value={getDeepValue(config, item.path)}
                      onChange={canInline ? (next) => updateField(item.path, next) : null}
                      onClear={canInline ? () => clearField(item.path) : null}
                      onEditInForm={() => setActiveTab('form')}
                    />
                  );
                })}
                </div>
              </div>
            ))}
          </div>
        </TabsContent>

        <TabsContent value="json">
          <Card className="border-zinc-800 bg-mil-bg-deep/60">
            <CardContent className="p-4">
              <div className="mb-3 rounded border border-zinc-700/50 bg-zinc-900/40 px-3 py-2 text-[11px] text-mil-dim">
                <strong className="text-mil-muted">Backend-managed fields:</strong> Network bindings (<code className="text-mil-dim">bindAddress</code>, <code className="text-mil-dim">bindPort</code>, <code className="text-mil-dim">publicAddress</code>, <code className="text-mil-dim">publicPort</code>, <code className="text-mil-dim">a2s.address</code>, <code className="text-mil-dim">a2s.port</code>, <code className="text-mil-dim">rcon.address</code>, <code className="text-mil-dim">rcon.port</code>) are overwritten on config regeneration. Edit them via Infrastructure settings instead.
              </div>
              <Textarea value={jsonText} onChange={(e) => { setJsonText(e.target.value); setJsonError(null); setJsonDraftDirty(true); markDirty(); }} disabled={saving} className={`min-h-[65vh] border-zinc-800 bg-mil-bg-deep/80 font-mono text-xs text-green-400 placeholder:text-mil-dim ${saving ? 'opacity-60' : ''}`} />
              {jsonError ? <div className="mt-2 text-xs text-red-400"><AlertTriangle className="mr-1 inline h-3 w-3" /> {jsonError}</div> : null}
              <p className="mt-2 text-[11px] text-mil-dim">
                Save now uses the current Raw JSON draft directly. Apply JSON is only needed if you want the form fields to sync to the edited config before saving.
              </p>
              <div className="mt-3 flex gap-2">
                <Button type="button" size="sm" onClick={handleJsonApply} className="bg-brand text-xs text-black hover:bg-brand-light">Apply JSON</Button>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      <Dialog open={diffOpen} onOpenChange={setDiffOpen}>
        <DialogContent className="w-[95vw] max-w-3xl border-zinc-800 bg-zinc-950 text-white">
          <DialogHeader><DialogTitle className="text-brand">Save Preview</DialogTitle></DialogHeader>
          <div className="max-h-[70vh] overflow-auto">
            {jsonDraftState.error ? (
              <div className="mb-3 rounded border border-red-600/30 bg-red-600/10 px-3 py-2 text-xs text-red-400">
                Preview is showing the last valid config because the Raw JSON draft cannot be parsed: {jsonDraftState.error}
              </div>
            ) : null}
            <pre className="whitespace-pre-wrap rounded bg-mil-bg-deep/80 p-4 font-mono text-xs text-green-400">
              {JSON.stringify({
                log_stats_enabled: runtime.log_stats_enabled,
                max_fps: runtime.max_fps,
                startup_parameters: parseListInput(textEditors.startupParameters),
                config: previewConfig,
              }, null, 2)}
            </pre>
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="outline" size="sm" onClick={() => setDiffOpen(false)} className="border-zinc-700 text-mil-muted">Close</Button>
            <Button type="button" size="sm" onClick={() => { saveConfig(); setDiffOpen(false); }} className="bg-brand text-black hover:bg-brand-light">
              <Save className="mr-1 h-3 w-3" /> Save Configuration
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={historyOpen} onOpenChange={setHistoryOpen}>
        <DialogContent className="w-[95vw] max-w-xl border-zinc-800 bg-zinc-950 text-white">
          <DialogHeader><DialogTitle className="text-brand">Configuration History</DialogTitle></DialogHeader>
          <div className="max-h-[60vh] space-y-2 overflow-auto">
            {configHistory.length === 0 ? (
              <p className="text-xs text-mil-dim">No configuration changes recorded.</p>
            ) : configHistory.map((entry, index) => (
              <div key={entry.id || entry.version || index} className="rounded border border-zinc-800 bg-mil-bg-deep/60 p-3">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-mil-muted">Version {entry.version ?? configHistory.length - index}</span>
                  <span className="text-mil-dim">{entry.changed_at ? new Date(entry.changed_at).toLocaleString() : ''}</span>
                </div>
                {entry.changed_by ? <div className="mt-1 text-[11px] text-mil-dim">by {entry.changed_by}</div> : null}
                <Button type="button"
                  size="sm"
                  variant="outline"
                  className="mt-2 h-6 border-zinc-800 text-[11px] text-mil-muted"
                  onClick={() => handleRestoreHistory(entry)}
                  disabled={historyRestoring !== null}
                >
                  {historyRestoring === (entry.version ?? 'legacy')
                    ? <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                    : <RotateCcw className="mr-1 h-3 w-3" />}
                  Restore
                </Button>
              </div>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </form>
  );
}

export default ServerSettingsModule;
