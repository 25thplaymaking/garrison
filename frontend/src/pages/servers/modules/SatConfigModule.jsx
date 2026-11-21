import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useOutletContext } from 'react-router';
import apiClient from '@/lib/apiClient';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import {
  Copy,
  Loader2,
  RefreshCw,
  RotateCcw,
  Save,
  Shield,
  ShieldAlert,
  TimerReset,
  Wrench,
} from 'lucide-react';
import { API } from '@/utils/api';
import { toast } from '@/hooks/use-toast';
import useConfirmDialog from '@/hooks/useConfirmDialog';
import { headingCase } from '@/utils/headingCase';

function describeError(error, fallback = 'Something went wrong.') {
  const detail = error?.response?.data?.detail;
  return (typeof detail === 'object' ? detail?.message : detail) || fallback;
}

const KNOWN_KEYS = new Set([
  'admins',
  'bans',
  'repeatedChatMessages',
  'scheduledChatMessages',
  'serverMessage',
  'serverMessageHeaderImage',
  'serverMessageDiscordLink',
  'serverMessageOpen',
  'statsFileName',
  'statsFileUpdateIntervalSeconds',
  'banReloadIntervalMinutes',
  'statsSaveConnectedPlayers',
  'eventsApiToken',
  'eventsApiAddress',
  'eventsApiRatelimitSeconds',
  'eventsApiEventsEnabled',
  'chatMessagesUtcTime',
  'repeatedChatMessagesCycle',
]);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function dedupeStringList(value) {
  const values = Array.isArray(value) ? value : String(value || '').split(/\r?\n|,/);
  const seen = new Set();
  return values
    .map((entry) => String(entry || '').trim())
    .filter((entry) => {
      if (!entry || seen.has(entry)) return false;
      seen.add(entry);
      return true;
    });
}

function normalizeAdminMap(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .map(([id, name]) => [String(id || '').trim(), String(name || '').trim()])
        .filter(([id]) => !!id),
    );
  }
  if (Array.isArray(value)) {
    return Object.fromEntries(
      value
        .filter((entry) => entry && typeof entry === 'object')
        .map((entry) => [String(entry.id || entry.playerId || '').trim(), String(entry.name || entry.label || '').trim()])
        .filter(([id]) => !!id),
    );
  }
  return {};
}

function normalizeBanMap(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .map(([id, reason]) => [String(id || '').trim(), String(reason || '').trim()])
        .filter(([id]) => !!id),
    );
  }
  if (Array.isArray(value)) {
    return Object.fromEntries(
      value
        .map((entry) => {
          if (entry && typeof entry === 'object') {
            return [String(entry.id || entry.playerId || entry.guid || '').trim(), String(entry.reason || '').trim()];
          }
          return [String(entry || '').trim(), ''];
        })
        .filter(([id]) => !!id),
    );
  }
  return {};
}

function SatConfigModule() {
  const { serverId, user, server } = useOutletContext();
  const { confirm, dialog: confirmDialog } = useConfirmDialog();
  const [configState, setConfigState] = useState({ available: false, status: 'pending', config: null });
  const [draft, setDraft] = useState(null);
  const [satStatus, setSatStatus] = useState(null);
  const [bans, setBans] = useState([]);
  const [advancedRaw, setAdvancedRaw] = useState('{}');
  const [advancedJsonError, setAdvancedJsonError] = useState('');
  // Raw, un-normalized text for the free-form list fields. Normalization
  // (trim/dedupe/split) only happens on save so the operator can type spaces,
  // blank lines, commas, and indentation freely while editing.
  const [serverMessageRaw, setServerMessageRaw] = useState('');
  const [eventsRaw, setEventsRaw] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [newBanId, setNewBanId] = useState('');
  const [newBanReason, setNewBanReason] = useState('');
  const [newAdminId, setNewAdminId] = useState('');
  const [newAdminName, setNewAdminName] = useState('');
  const [workingAction, setWorkingAction] = useState('');
  // A failed read (permissions, malformed JSON) is not the same as "SAT has
  // not generated its config yet"; keep the reason so the empty state can say so.
  const [loadError, setLoadError] = useState('');

  const refreshAll = useCallback(async () => {
    setLoading(true);
    try {
      const [configRes, statusRes, bansRes] = await Promise.allSettled([
        apiClient.get(`/servers/${serverId}/sat-config`),
        apiClient.get(`/servers/${serverId}/sat/status`),
        apiClient.get(`/servers/${serverId}/sat/bans`),
      ]);

      if (configRes.status === 'rejected') {
        setLoadError(describeError(configRes.reason, 'Could not read the Server Admin Tools config.'));
      } else {
        setLoadError('');
      }
      if (configRes.status === 'fulfilled') {
        setConfigState(configRes.value.data);
        const nextDraft = configRes.value.data?.config ? clone(configRes.value.data.config) : null;
        setDraft(nextDraft);
        const advanced = {};
        Object.entries(nextDraft || {}).forEach(([key, value]) => {
          if (!KNOWN_KEYS.has(key)) advanced[key] = value;
        });
        setAdvancedRaw(JSON.stringify(advanced, null, 2));
        setServerMessageRaw(
          Array.isArray(nextDraft?.serverMessage)
            ? nextDraft.serverMessage.join('\n')
            : String(nextDraft?.serverMessage || ''),
        );
        setEventsRaw(
          Array.isArray(nextDraft?.eventsApiEventsEnabled)
            ? nextDraft.eventsApiEventsEnabled.join(', ')
            : String(nextDraft?.eventsApiEventsEnabled || ''),
        );
      }
      if (statusRes.status === 'fulfilled') setSatStatus(statusRes.value.data);
      if (bansRes.status === 'fulfilled') setBans(bansRes.value.data?.bans || []);
    } finally {
      setLoading(false);
    }
  }, [serverId]);

  useEffect(() => {
    refreshAll();
  }, [refreshAll]);

  const updateField = useCallback((key, value) => {
    setDraft((current) => ({ ...(current || {}), [key]: value }));
  }, []);

  const updateArrayItem = useCallback((key, index, patch) => {
    setDraft((current) => {
      const next = clone(current || {});
      const list = Array.isArray(next[key]) ? [...next[key]] : [];
      list[index] = { ...(list[index] || {}), ...patch };
      next[key] = list;
      return next;
    });
  }, []);

  const addArrayItem = useCallback((key, item) => {
    setDraft((current) => {
      const next = clone(current || {});
      next[key] = [...(Array.isArray(next[key]) ? next[key] : []), item];
      return next;
    });
  }, []);

  const removeArrayItem = useCallback((key, index) => {
    setDraft((current) => {
      const next = clone(current || {});
      next[key] = (Array.isArray(next[key]) ? next[key] : []).filter((_, currentIndex) => currentIndex !== index);
      return next;
    });
  }, []);

  const saveConfig = useCallback(async () => {
    if (!draft) return;

    // Validate the Advanced JSON textarea before attempting a save.
    let advanced = {};
    if (advancedRaw.trim()) {
      try {
        const parsed = JSON.parse(advancedRaw);
        if (typeof parsed !== 'object' || Array.isArray(parsed) || parsed === null) {
          setAdvancedJsonError('Advanced JSON must be a plain object (e.g. {"key": "value"}).');
          return;
        }
        // Strip keys that are managed by the structured UI so they cannot
        // silently override the form values the operator just set.
        Object.keys(parsed).forEach((key) => {
          if (!KNOWN_KEYS.has(key)) advanced[key] = parsed[key];
        });
        setAdvancedJsonError('');
      } catch {
        setAdvancedJsonError('Advanced JSON is not valid — fix the syntax before saving.');
        return;
      }
    }

    setSaving(true);
    try {
      const nextConfig = Object.fromEntries(
        Object.entries(draft).filter(([key]) => KNOWN_KEYS.has(key)),
      );
      const normalizedAdmins = normalizeAdminMap(draft.admins);
      const normalizedBans = normalizeBanMap(draft.bans);
      const normalizedServerMessage = dedupeStringList(serverMessageRaw);
      const normalizedEvents = dedupeStringList(eventsRaw);

      const satPayload = {
        config: {
          // Unknown keys come first so structured/KNOWN_KEYS values always win.
          ...advanced,
          ...nextConfig,
          admins: normalizedAdmins,
          bans: normalizedBans,
          serverMessage: normalizedServerMessage,
          eventsApiEventsEnabled: normalizedEvents,
        },
      };
      await apiClient.put(`/servers/${serverId}/sat-config`, satPayload, {
        validateStatus: (s) => s < 400,
      });
      await refreshAll();
      toast({ title: 'SAT config saved' });
    } catch (error) {
      toast({ variant: 'destructive', title: 'Could not save SAT config', description: describeError(error) });
    } finally {
      setSaving(false);
    }
  }, [advancedRaw, draft, eventsRaw, refreshAll, server?.name, serverId, serverMessageRaw, user]);

  const handleRestoreDefaults = useCallback(async () => {
    if (!(await confirm({
      title: 'Restore SAT defaults?',
      description: 'This overwrites the live SAT config with the host baseline and reloads the editor from it — any unsaved edits above will be lost.',
      destructive: true,
      confirmLabel: 'Restore defaults',
    }))) return;
    setWorkingAction('restore');
    try {
      await apiClient.post(`/servers/${serverId}/sat/tools/restore-defaults`);
      await refreshAll();
      toast({ title: 'SAT config restored to defaults' });
    } catch (error) {
      toast({ variant: 'destructive', title: 'Could not restore defaults', description: describeError(error) });
    } finally {
      setWorkingAction('');
    }
  }, [confirm, refreshAll, serverId]);

  const handleCopyFromServer = useCallback(async () => {
    setWorkingAction('copy');
    try {
      await apiClient.post(`/servers/${serverId}/sat/tools/copy-from-server`);
      await refreshAll();
      toast({ title: 'SAT config refreshed from server' });
    } catch (error) {
      toast({ variant: 'destructive', title: 'Could not copy from server', description: describeError(error) });
    } finally {
      setWorkingAction('');
    }
  }, [refreshAll, serverId]);

  const addBan = useCallback(async () => {
    if (!newBanId.trim()) return;
    setWorkingAction('add-ban');
    try {
      await apiClient.post(`/servers/${serverId}/sat/bans`, { player_id: newBanId.trim(), reason: newBanReason.trim() });
      setNewBanId('');
      setNewBanReason('');
      await refreshAll();
      toast({ title: 'Ban added' });
    } catch (error) {
      toast({ variant: 'destructive', title: 'Could not add ban', description: describeError(error) });
    } finally {
      setWorkingAction('');
    }
  }, [newBanId, newBanReason, refreshAll, serverId]);

  const removeBan = useCallback(async (playerId) => {
    if (!(await confirm({
      title: 'Remove SAT ban?',
      description: `This unbans ${playerId} from the SAT config.`,
      destructive: true,
      confirmLabel: 'Remove ban',
    }))) return;
    setWorkingAction(`remove-${playerId}`);
    try {
      await apiClient.delete(`/servers/${serverId}/sat/bans/${playerId}`);
      await refreshAll();
      toast({ title: 'Ban removed' });
    } catch (error) {
      toast({ variant: 'destructive', title: 'Could not remove ban', description: describeError(error) });
    } finally {
      setWorkingAction('');
    }
  }, [confirm, refreshAll, serverId]);

  const syncBans = useCallback(async () => {
    setWorkingAction('sync-bans');
    try {
      await apiClient.post(`/servers/${serverId}/sat/bans/sync`);
      await refreshAll();
      toast({ title: 'Bans synced to runtime' });
    } catch (error) {
      toast({ variant: 'destructive', title: 'Could not sync bans', description: describeError(error) });
    } finally {
      setWorkingAction('');
    }
  }, [refreshAll, serverId]);

  const admins = useMemo(() => {
    const source = draft?.admins;
    if (Array.isArray(source)) return source.map((entry, index) => ({ id: entry.id || entry.playerId || `${index}`, name: entry.name || entry.label || '' }));
    if (source && typeof source === 'object') return Object.entries(source).map(([id, name]) => ({ id, name: String(name || '') }));
    return [];
  }, [draft?.admins]);

  const addAdmin = useCallback(() => {
    const adminId = String(newAdminId || '').trim();
    if (!adminId) return;
    setDraft((current) => {
      const next = clone(current || {});
      next.admins = {
        ...normalizeAdminMap(next.admins),
        [adminId]: String(newAdminName || '').trim(),
      };
      return next;
    });
    setNewAdminId('');
    setNewAdminName('');
  }, [newAdminId, newAdminName]);

  const updateAdminName = useCallback((adminId, name) => {
    setDraft((current) => {
      const next = clone(current || {});
      next.admins = {
        ...normalizeAdminMap(next.admins),
        [adminId]: name,
      };
      return next;
    });
  }, []);

  const removeAdmin = useCallback((adminId) => {
    setDraft((current) => {
      const next = clone(current || {});
      const adminMap = normalizeAdminMap(next.admins);
      delete adminMap[adminId];
      next.admins = adminMap;
      return next;
    });
  }, []);

  if (loading && !draft) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="h-6 w-6 animate-spin text-brand" />
      </div>
    );
  }

  if (!configState?.available && loadError) {
    return (
      <div role="alert" className="relative corner-bracket border border-red-500/30 bg-red-500/[0.06] py-14 text-center">
        <ShieldAlert className="mx-auto mb-3 h-8 w-8 text-red-300" />
        <p className="text-sm text-mil-fg" style={{ fontFamily: "var(--font-heading)" }}>Server Admin Tools config could not be read.</p>
        <p className="mx-auto mt-1.5 max-w-xl wrap-break-word px-4 text-xs text-red-200/90" style={{ fontFamily: "var(--font-mono)" }}>
          {loadError}
        </p>
        <button
          type="button"
          onClick={refreshAll}
          disabled={loading}
          className="mt-4 inline-flex min-h-11 items-center px-3.5 py-2 text-[11px] font-bold text-mil-muted border border-[rgba(232,131,58,0.18)] hover:border-[rgba(232,131,58,0.4)] hover:text-mil-fg disabled:opacity-40 transition-colors sm:min-h-9 capitalize"
          style={{ fontFamily: "var(--font-condensed)" }}
        >
          {loading ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="mr-1.5 h-3.5 w-3.5" />} Try again
        </button>
      </div>
    );
  }

  if (!configState?.available) {
    return (
      <div className="relative corner-bracket border border-[rgba(232,131,58,0.12)] bg-mil-bg-panel/75 py-14 text-center">
        <ShieldAlert className="mx-auto mb-3 h-8 w-8 text-mil-dim" />
        <p className="text-sm text-mil-fg" style={{ fontFamily: "var(--font-heading)" }}>Server Admin Tools config is not available yet.</p>
        <p className="mx-auto mt-1.5 max-w-md text-xs text-mil-dim" style={{ fontFamily: "var(--font-body)" }}>
          Current state: <span className="text-brand">{configState?.status || 'pending'}</span>. Start the server and let the profile finish generating before editing SAT.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {confirmDialog}
      {/* ── Command header ─────────────────────────────────────────── */}
      <div className="relative overflow-hidden border border-[rgba(232,131,58,0.15)] bg-mil-bg-panel/75 p-4">
        <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(90deg,rgba(232,131,58,0.04)_1px,transparent_1px)] bg-size-[32px_32px] opacity-70" />
        <div className="relative flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center border border-[rgba(232,131,58,0.25)] bg-mil-bg-deep">
              <Wrench className="h-5 w-5 text-brand" />
            </div>
            <div>
              <h2 className="text-base font-semibold text-mil-bright" style={{ fontFamily: "var(--font-heading)" }}>
                Server Admin Tools
              </h2>
              <p className="mt-0.5 max-w-2xl text-xs text-mil-dim" style={{ fontFamily: "var(--font-body)" }}>
                Structured SAT control surface — live status, ban management, operator messaging, events wiring, and recovery.
              </p>
            </div>
          </div>
          <div className="flex gap-2">
            <Button type="button" variant="commandOutline" onClick={refreshAll}>
              <RefreshCw aria-hidden="true" /> Refresh
            </Button>
            <Button type="button" variant="commandPrimary" onClick={saveConfig} disabled={!draft || saving}>
              {saving ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Save aria-hidden="true" />}
              Save SAT
            </Button>
          </div>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatusTile label="SAT Status" value={satStatus?.sat_status || configState?.status || 'pending'} accent />
        <StatusTile label="Players" value={satStatus?.player_count ?? 'Unavailable'} />
        <StatusTile label="Server FPS" value={satStatus?.server_fps ?? 'Unavailable'} />
        <StatusTile label="Avg Ping" value={satStatus?.avg_player_ping_ms != null ? `${satStatus.avg_player_ping_ms} ms` : 'Unavailable'} />
      </div>

      <SectionCard title="Ban Manager" icon={Shield}>
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
          <div className="space-y-3">
            <div className="grid gap-2 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
              <Input value={newBanId} onChange={(event) => setNewBanId(event.target.value)} placeholder="Player ID / GUID" className="h-9 rounded-none border-[rgba(232,131,58,0.15)] bg-mil-bg-deep text-mil-fg placeholder:text-mil-dim focus-visible:ring-[rgba(232,131,58,0.3)]" style={{ fontFamily: "var(--font-mono)" }} />
              <Input value={newBanReason} onChange={(event) => setNewBanReason(event.target.value)} placeholder="Reason (optional)" className="h-9 rounded-none border-[rgba(232,131,58,0.15)] bg-mil-bg-deep text-mil-fg placeholder:text-mil-dim focus-visible:ring-[rgba(232,131,58,0.3)]" style={{ fontFamily: "var(--font-mono)" }} />
              <button
                type="button"
                onClick={addBan}
                disabled={!newBanId.trim() || workingAction === 'add-ban'}
                className="inline-flex h-9 items-center justify-center px-4 text-[11px] font-bold bg-brand text-[#0f0f0f] border border-[rgba(232,131,58,0.5)] hover:bg-brand-light disabled:opacity-40 disabled:cursor-not-allowed transition-colors capitalize"
                style={{ fontFamily: "var(--font-condensed)" }}
              >
                {workingAction === 'add-ban' ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
                Add ban
              </button>
            </div>
            <div className="space-y-2">
              {bans.length === 0 ? (
                <p className="text-xs text-mil-dim" style={{ fontFamily: "var(--font-body)" }}>No SAT bans are configured yet.</p>
              ) : (
                bans.map((ban) => (
                  <div key={ban.id} className="flex items-center gap-3 border border-[rgba(232,131,58,0.1)] bg-mil-bg-deep/60 p-3">
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm text-mil-fg" style={{ fontFamily: "var(--font-mono)" }}>{ban.id}</div>
                      <div className="text-xs text-mil-dim">{ban.reason || 'No reason provided'}</div>
                    </div>
                    <button type="button" onClick={() => removeBan(ban.id)} className="text-[11px] font-bold text-mil-dim hover:text-brand-light transition-colors" style={{ fontFamily: "var(--font-condensed)" }}>
                      Remove
                    </button>
                  </div>
                ))
              )}
            </div>
          </div>
          <div className="border border-[rgba(232,131,58,0.1)] bg-mil-bg-deep/60 p-4">
            <div className="text-sm font-semibold text-mil-fg" style={{ fontFamily: "var(--font-heading)" }}>Live Sync</div>
            <p className="mt-1 text-xs text-mil-dim" style={{ fontFamily: "var(--font-body)" }}>
              Replay SAT bans against the live server when BattlEye RCON is available.
            </p>
            <Button type="button" variant="command" onClick={syncBans} disabled={workingAction === 'sync-bans'} className="mt-4">
              {workingAction === 'sync-bans' ? <Loader2 className="animate-spin" aria-hidden="true" /> : <RefreshCw aria-hidden="true" />}
              Sync bans to runtime
            </Button>
          </div>
        </div>
      </SectionCard>

      <SectionCard title="Settings" icon={TimerReset}>
        <div className="grid gap-4 xl:grid-cols-2">
          <div className="space-y-3">
            <div className="border border-[rgba(232,131,58,0.1)] bg-mil-bg-deep/60 p-4">
              <div className="text-xs font-medium text-brand">Admins</div>
              <div className="mt-3 grid gap-2 md:grid-cols-[180px_minmax(0,1fr)_auto]">
                <Input value={newAdminId} onChange={(event) => setNewAdminId(event.target.value)} placeholder="Admin identity / GUID" className="h-8 rounded-none border-[rgba(232,131,58,0.15)] bg-mil-bg-deep text-xs text-mil-fg placeholder:text-mil-dim focus-visible:ring-[rgba(232,131,58,0.3)]" style={{ fontFamily: "var(--font-mono)" }} />
                <Input value={newAdminName} onChange={(event) => setNewAdminName(event.target.value)} placeholder="Display name" className="h-8 rounded-none border-[rgba(232,131,58,0.15)] bg-mil-bg-deep text-xs text-mil-fg placeholder:text-mil-dim focus-visible:ring-[rgba(232,131,58,0.3)]" style={{ fontFamily: "var(--font-mono)" }} />
                <Button type="button" variant="command" size="sm" onClick={addAdmin} disabled={!newAdminId.trim()}>
                  Add admin
                </Button>
              </div>
              <div className="mt-3 space-y-2">
                {admins.length === 0 ? (
                  <p className="text-xs text-mil-dim" style={{ fontFamily: "var(--font-body)" }}>No explicit SAT admins found in the current config.</p>
                ) : (
                  admins.map((admin) => (
                    <div key={admin.id} className="grid gap-2 md:grid-cols-[180px_minmax(0,1fr)_auto]">
                      <Input value={admin.id} readOnly className="h-8 rounded-none border-[rgba(232,131,58,0.1)] bg-mil-bg-deep/60 text-xs text-mil-muted" style={{ fontFamily: "var(--font-mono)" }} />
                      <Input value={admin.name} onChange={(event) => updateAdminName(admin.id, event.target.value)} className="h-8 rounded-none border-[rgba(232,131,58,0.15)] bg-mil-bg-deep text-xs text-mil-fg focus-visible:ring-[rgba(232,131,58,0.3)]" style={{ fontFamily: "var(--font-mono)" }} />
                      <button type="button" onClick={() => removeAdmin(admin.id)} className="px-2 text-[11px] font-bold text-mil-dim hover:text-brand-light transition-colors" style={{ fontFamily: "var(--font-condensed)" }}>
                        Remove
                      </button>
                    </div>
                  ))
                )}
              </div>
            </div>
            <div className="border border-[rgba(232,131,58,0.1)] bg-mil-bg-deep/60 p-4">
              <div className="grid gap-3 md:grid-cols-2">
                <LabeledInput label="Stats File" value={draft?.statsFileName || ''} onChange={(value) => updateField('statsFileName', value)} />
                <LabeledInput label="Stats File Update Interval (s)" type="number" value={draft?.statsFileUpdateIntervalSeconds ?? 0} onChange={(value) => updateField('statsFileUpdateIntervalSeconds', Number(value || 0))} />
                <LabeledInput label="Ban Reload Interval (min)" type="number" value={draft?.banReloadIntervalMinutes ?? 0} onChange={(value) => updateField('banReloadIntervalMinutes', Number(value || 0))} />
                <ToggleField label="Save Connected Players" checked={!!draft?.statsSaveConnectedPlayers} onCheckedChange={(value) => updateField('statsSaveConnectedPlayers', value)} />
                <ToggleField label="Chat Messages Use UTC" checked={!!draft?.chatMessagesUtcTime} onCheckedChange={(value) => updateField('chatMessagesUtcTime', value)} />
                <ToggleField label="Cycle Repeated Messages" checked={!!draft?.repeatedChatMessagesCycle} onCheckedChange={(value) => updateField('repeatedChatMessagesCycle', value)} />
              </div>
            </div>
          </div>
        </div>
      </SectionCard>

      <SectionCard title="Repeated Chat Messages" icon={Copy}>
        <ArraySection
          items={draft?.repeatedChatMessages || []}
          onAdd={() => addArrayItem('repeatedChatMessages', { message: '', intervalMinutes: 15 })}
          onRemove={(index) => removeArrayItem('repeatedChatMessages', index)}
          renderItem={(item, index) => (
            <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_140px]">
              <Textarea value={item.message || ''} onChange={(event) => updateArrayItem('repeatedChatMessages', index, { message: event.target.value })} rows={3} className="rounded-none border-[rgba(232,131,58,0.15)] bg-mil-bg-deep text-sm text-mil-fg focus-visible:ring-[rgba(232,131,58,0.3)]" />
              <LabeledInput label="Interval (min)" type="number" value={item.intervalMinutes ?? 15} onChange={(value) => updateArrayItem('repeatedChatMessages', index, { intervalMinutes: Number(value || 0) })} />
            </div>
          )}
        />
      </SectionCard>

      <SectionCard title="Scheduled Chat Messages" icon={Copy}>
        <ArraySection
          items={draft?.scheduledChatMessages || []}
          onAdd={() => addArrayItem('scheduledChatMessages', { message: '', hour: 0, minute: 0 })}
          onRemove={(index) => removeArrayItem('scheduledChatMessages', index)}
          renderItem={(item, index) => (
            <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_120px_120px]">
              <Textarea value={item.message || ''} onChange={(event) => updateArrayItem('scheduledChatMessages', index, { message: event.target.value })} rows={3} className="rounded-none border-[rgba(232,131,58,0.15)] bg-mil-bg-deep text-sm text-mil-fg focus-visible:ring-[rgba(232,131,58,0.3)]" />
              <LabeledInput label="Hour" type="number" value={item.hour ?? 0} onChange={(value) => updateArrayItem('scheduledChatMessages', index, { hour: Number(value || 0) })} />
              <LabeledInput label="Minute" type="number" value={item.minute ?? 0} onChange={(value) => updateArrayItem('scheduledChatMessages', index, { minute: Number(value || 0) })} />
            </div>
          )}
        />
      </SectionCard>

      <SectionCard title="Welcome Message" icon={Copy}>
        <div className="grid gap-4 xl:grid-cols-2">
          <div className="space-y-1.5">
            <Textarea
              value={serverMessageRaw}
              onChange={(event) => setServerMessageRaw(event.target.value)}
              rows={8}
              className="rounded-none border-[rgba(232,131,58,0.15)] bg-mil-bg-deep text-sm text-mil-fg focus-visible:ring-[rgba(232,131,58,0.3)]"
            />
            <p className="text-[11px] text-mil-dim">One message per line. Blank lines and spacing are preserved; entries are de-duplicated on save.</p>
          </div>
          <div className="space-y-3">
            <LabeledInput label="Header Image" value={draft?.serverMessageHeaderImage || ''} onChange={(value) => updateField('serverMessageHeaderImage', value)} />
            <LabeledInput label="Discord Link" value={draft?.serverMessageDiscordLink || ''} onChange={(value) => updateField('serverMessageDiscordLink', value)} />
            <ToggleField label="Open Welcome Message Automatically" checked={!!draft?.serverMessageOpen} onCheckedChange={(value) => updateField('serverMessageOpen', value)} />
          </div>
        </div>
      </SectionCard>

      <SectionCard title="Events API" icon={Wrench}>
        <div className="grid gap-3 xl:grid-cols-2">
          <LabeledInput label="Events API Token" value={draft?.eventsApiToken || ''} onChange={(value) => updateField('eventsApiToken', value)} />
          <LabeledInput label="Events API Address" value={draft?.eventsApiAddress || ''} onChange={(value) => updateField('eventsApiAddress', value)} />
          <LabeledInput label="Rate Limit (s)" type="number" value={draft?.eventsApiRatelimitSeconds ?? 0} onChange={(value) => updateField('eventsApiRatelimitSeconds', Number(value || 0))} />
          <div>
            <div className="mb-1 text-xs font-medium text-mil-dim">Enabled Events</div>
            <Textarea
              value={eventsRaw}
              onChange={(event) => setEventsRaw(event.target.value)}
              rows={4}
              className="rounded-none border-[rgba(232,131,58,0.15)] bg-mil-bg-deep text-sm text-mil-fg focus-visible:ring-[rgba(232,131,58,0.3)]"
            />
            <p className="mt-1 text-[11px] text-mil-dim">Separate events with commas or new lines; normalized on save.</p>
          </div>
        </div>
      </SectionCard>

      <SectionCard title="Tools" icon={RotateCcw}>
        <div className="grid gap-4 lg:grid-cols-2">
          <ToolCard
            title="Restore Defaults"
            description="Reapply the SAT baseline configured on the host."
            buttonLabel="Restore defaults"
            icon={RotateCcw}
            loading={workingAction === 'restore'}
            onClick={handleRestoreDefaults}
          />
          <ToolCard
            title="Copy From Server"
            description="Refresh this editor from the discovered SAT config currently on disk."
            buttonLabel="Copy from server"
            icon={Copy}
            loading={workingAction === 'copy'}
            onClick={handleCopyFromServer}
          />
        </div>
      </SectionCard>

      <SectionCard title="Advanced" icon={ShieldAlert}>
        <p className="mb-3 text-xs text-mil-dim">
          Unknown SAT keys stay editable here so structured coverage can improve without blocking uncommon fields.
          Known keys entered here are ignored — use the structured fields above.
        </p>
        <Textarea
          value={advancedRaw}
          onChange={(event) => {
            setAdvancedRaw(event.target.value);
            if (advancedJsonError) setAdvancedJsonError('');
          }}
          rows={12}
          className={`rounded-none border-[rgba(232,131,58,0.15)] bg-mil-bg-deep font-mono text-xs text-mil-fg focus-visible:ring-[rgba(232,131,58,0.3)] ${advancedJsonError ? 'border-red-500/60' : ''}`}
        />
        {advancedJsonError && (
          <p className="mt-1.5 text-xs text-red-400">{advancedJsonError}</p>
        )}
      </SectionCard>
    </div>
  );
}

function StatusTile({ label, value, accent = false }) {
  return (
    <div className="relative overflow-hidden border border-[rgba(232,131,58,0.12)] bg-mil-bg-panel/75 p-4">
      <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(90deg,rgba(232,131,58,0.04)_1px,transparent_1px)] bg-size-[24px_24px] opacity-60" />
      <div className="absolute left-0 top-0 h-full w-[2px] bg-linear-to-b from-[rgba(232,131,58,0.55)] to-transparent" />
      <div className="relative flex items-center gap-1.5 text-xs font-medium text-mil-muted capitalize">
        {accent && <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-brand" />}
        {label}
      </div>
      <div className={`relative mt-2 truncate text-2xl font-semibold ${accent ? 'text-brand-light' : 'text-mil-fg'}`} style={{ fontFamily: "var(--font-heading)" }}>
        {value}
      </div>
    </div>
  );
}

function SectionCard({ title, icon: Icon, children }) {
  return (
    <div className="relative corner-bracket border border-[rgba(232,131,58,0.12)] bg-mil-bg-panel/75">
      <div className="relative flex items-center gap-2 overflow-hidden border-b border-[rgba(232,131,58,0.12)] bg-mil-bg-panel px-4 py-2.5">
        <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(90deg,rgba(232,131,58,0.04)_1px,transparent_1px)] bg-size-[32px_32px] opacity-70" />
        <Icon className="relative h-4 w-4 text-brand" />
        <h3 className="relative text-xs font-semibold text-mil-fg" style={{ fontFamily: "var(--font-heading)" }}>{headingCase(title)}</h3>
      </div>
      <div className="p-4">{children}</div>
    </div>
  );
}

function LabeledInput({ label, value, onChange, type = 'text' }) {
  return (
    <div className="space-y-1.5">
      <div className="text-xs font-medium text-mil-muted capitalize">{label}</div>
      <Input
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-9 rounded-none border-[rgba(232,131,58,0.15)] bg-mil-bg-deep text-mil-fg focus-visible:ring-[rgba(232,131,58,0.3)]"
        style={{ fontFamily: "var(--font-mono)" }}
      />
    </div>
  );
}

function ToggleField({ label, checked, onCheckedChange }) {
  return (
    <div className="flex items-center justify-between border border-[rgba(232,131,58,0.1)] bg-mil-bg-deep px-3 py-3">
      <div className="text-xs font-medium text-mil-muted capitalize">{label}</div>
      <Switch checked={checked} onCheckedChange={onCheckedChange} className="h-5 w-9" />
    </div>
  );
}

function ArraySection({ items, onAdd, onRemove, renderItem }) {
  return (
    <div className="space-y-3">
      {items.length === 0 && <p className="text-xs text-mil-dim" style={{ fontFamily: "var(--font-body)" }}>No entries configured yet.</p>}
      {items.map((item, index) => (
        <div key={`item-${index}`} className="space-y-3 border border-[rgba(232,131,58,0.1)] bg-mil-bg-deep/60 p-4">
          {renderItem(item, index)}
          <div className="flex justify-end">
            <button type="button" onClick={() => onRemove(index)} className="text-[11px] font-bold text-mil-dim hover:text-brand-light transition-colors" style={{ fontFamily: "var(--font-condensed)" }}>
              Remove
            </button>
          </div>
        </div>
      ))}
      <Button type="button" variant="command" onClick={onAdd}>
        + Add entry
      </Button>
    </div>
  );
}

function ToolCard({ title, description, buttonLabel, icon: Icon, onClick, loading }) {
  return (
    <div className="border border-[rgba(232,131,58,0.1)] bg-mil-bg-deep/60 p-4">
      <div className="flex items-center gap-2 text-sm font-semibold text-mil-fg" style={{ fontFamily: "var(--font-heading)" }}>
        <Icon className="h-4 w-4 text-brand" /> {title}
      </div>
      <p className="mt-2 text-xs text-mil-dim" style={{ fontFamily: "var(--font-body)" }}>{description}</p>
      <Button type="button" variant="command" onClick={onClick} disabled={loading} className="mt-4">
        {loading ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
        {buttonLabel}
      </Button>
    </div>
  );
}

export default SatConfigModule;
