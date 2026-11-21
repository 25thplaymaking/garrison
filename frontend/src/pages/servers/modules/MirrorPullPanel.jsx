import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowDownToLine,
  ChevronDown,
  ChevronRight,
  Loader2,
  Minus,
  Plus,
  RefreshCw,
  Server,
} from 'lucide-react';
import apiClient from '@/lib/apiClient';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { toast } from '@/hooks/use-toast';
import { formatApiError } from '@/utils/errorMessages';

const OPTIONS = [
  ['preserve_system_managed', 'Keep this server\'s system-managed mods', 'SAT and other panel-managed entries stay in place.'],
  ['include_disabled', 'Include disabled mods', 'Copy the source\'s disabled entries too.'],
  ['include_pinned_versions', 'Copy pinned versions', 'Bring over the source\'s version locks. Off pulls every mod at latest.'],
  ['create_backups', 'Back up this server first', 'Snapshot the current load order before it is replaced.'],
];

function DiffList({ title, items, tone, icon: Icon }) {
  const [open, setOpen] = useState(false);
  if (!items?.length) return null;
  return (
    <div className="rounded-lg border border-white/[0.06] bg-black/20">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-xs"
      >
        <span className={`flex items-center gap-1.5 font-medium ${tone}`}>
          <Icon className="h-3.5 w-3.5" /> {items.length} {title}
        </span>
        {open ? <ChevronDown className="h-3.5 w-3.5 text-mil-dim" /> : <ChevronRight className="h-3.5 w-3.5 text-mil-dim" />}
      </button>
      {open ? (
        <ul className="max-h-48 space-y-0.5 overflow-auto border-t border-white/[0.06] px-3 py-2 text-[11px] text-mil-muted">
          {items.map((item) => (
            <li key={item.mod_id} className="flex justify-between gap-2">
              <span className="truncate">{item.name || item.mod_id}</span>
              <span className="shrink-0 font-mono text-mil-dim/70">{item.mod_id}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/**
 * Pull another server's saved mod loadout onto this one.
 *
 * The reverse of the push mirror: you work from the server you are changing.
 * It goes through the same mirror path on the backend
 * (`/servers/{id}/mods/mirror-from`), so backups and the mod
 * revision trail are identical.
 */
export default function MirrorPullPanel({
  server,
  serverId,
  sources,
  loadingSources,
  onRefreshSources,
  dirty,
  canManage,
  user,
  onApplied,
}) {
  const [sourceId, setSourceId] = useState('');
  const [options, setOptions] = useState({
    preserve_system_managed: true,
    include_disabled: true,
    include_pinned_versions: true,
    create_backups: true,
  });
  const [afterPull, setAfterPull] = useState('none');
  const [preview, setPreview] = useState(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState('');
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [running, setRunning] = useState(false);

  const source = useMemo(() => sources.find((item) => String(item.id) === String(sourceId)), [sourceId, sources]);

  const loadPreview = useCallback(async () => {
    if (!sourceId) {
      setPreview(null);
      return;
    }
    setPreviewLoading(true);
    setPreviewError('');
    try {
      const params = new URLSearchParams({
        source_server_id: sourceId,
        preserve_system_managed: String(options.preserve_system_managed),
        include_disabled: String(options.include_disabled),
        include_pinned_versions: String(options.include_pinned_versions),
      });
      const res = await apiClient.get(`/servers/${serverId}/mods/mirror-preview?${params.toString()}`);
      setPreview(res.data);
    } catch (error) {
      setPreview(null);
      setPreviewError(formatApiError(error, 'Could not preview the pull.'));
    } finally {
      setPreviewLoading(false);
    }
  }, [options.include_disabled, options.include_pinned_versions, options.preserve_system_managed, serverId, sourceId]);

  useEffect(() => { loadPreview(); }, [loadPreview]);

  const executePull = useCallback(async () => {
    if (!sourceId || dirty || !canManage) return;
    setRunning(true);
    try {
      const payload = {
        source_server_id: sourceId,
        ...options,
        restart_target: afterPull === 'restart',
        reconfigure_target: afterPull === 'reconfigure',
      };
      const res = await apiClient.post(`/servers/${serverId}/mods/mirror-from`, payload, {
        validateStatus: (status) => status < 400,
      });
      setConfirmOpen(false);
      const result = (res.data?.results || [])[0] || {};
      if (!result.ok) {
        toast({ title: 'Pull failed', description: result.error || 'The loadout was not changed.', variant: 'destructive' });
        return;
      }
      toast({
        title: 'Loadout pulled',
        description: result.post_action_error
          ? `${result.mod_count} mods applied from ${source?.name || sourceId}, but ${result.post_action_error}`
          : `${result.mod_count} mods applied from ${source?.name || sourceId}.${result.backup_id ? ` Backup ${result.backup_id}.` : ''}`,
      });
      await onApplied?.();
      await loadPreview();
    } catch (error) {
      toast({ title: 'Pull failed', description: formatApiError(error, 'The loadout was not changed.'), variant: 'destructive' });
    } finally {
      setRunning(false);
    }
  }, [afterPull, canManage, dirty, loadPreview, onApplied, options, server?.name, serverId, source?.name, sourceId, user]);

  const diff = preview?.diff;
  const noChanges = diff && !diff.added_count && !diff.removed_count && !diff.version_changed_count && !diff.enabled_changed_count;

  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
      <section className="rounded-xl border border-white/[0.07] bg-mil-bg-panel/70">
        <header className="flex flex-wrap items-center justify-between gap-2 border-b border-white/[0.06] px-4 py-3">
          <div>
            <h3 className="flex items-center gap-2 text-sm font-semibold text-mil-fg">
              <ArrowDownToLine className="h-4 w-4 text-brand" /> Pull a loadout into {server?.name || 'this server'}
            </h3>
            <p className="mt-0.5 text-xs text-mil-dim">Pick the server to copy from. This server's load order is replaced with that server's saved load order.</p>
          </div>
          <Button size="sm" variant="outline" onClick={onRefreshSources} disabled={loadingSources} className="h-8 gap-1.5 text-xs">
            {loadingSources ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />} Refresh
          </Button>
        </header>
        <div className="space-y-3 p-4">
          {dirty ? (
            <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-200">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              Deploy or discard this server's unsaved load-order changes first; a pull replaces them.
            </div>
          ) : null}

          {loadingSources ? (
            <div className="flex items-center justify-center py-10 text-sm text-mil-dim">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading servers…
            </div>
          ) : sources.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-10 text-sm text-mil-dim">
              <Server className="h-6 w-6" /> No other managed servers.
            </div>
          ) : (
            <div role="radiogroup" aria-label="Source server" className="grid grid-cols-1 gap-2 md:grid-cols-2">
              {sources.map((item) => {
                const selected = String(item.id) === String(sourceId);
                const modCount = Array.isArray(item.mods) ? item.mods.length : 0;
                return (
                  <button
                    key={item.id}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    onClick={() => setSourceId(selected ? '' : item.id)}
                    className={`flex items-center gap-3 rounded-lg border p-3 text-left transition-colors ${
                      selected ? 'border-brand/60 bg-brand/10' : 'border-white/[0.07] bg-black/20 hover:border-white/15'
                    }`}
                  >
                    <span className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${selected ? 'border-brand' : 'border-mil-dim/60'}`}>
                      {selected ? <span className="h-2 w-2 rounded-full bg-brand" /> : null}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-mil-fg">{item.name || item.id}</span>
                      <span className="block text-[11px] text-mil-dim">{modCount} mods · {item.status || 'unknown'}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          )}

          {sourceId ? (
            <div className="space-y-2 rounded-lg border border-white/[0.07] bg-mil-bg-deep/60 p-3">
              <div className="flex items-center justify-between gap-2 text-xs">
                <span className="font-semibold text-mil-soft">What changes</span>
                {previewLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin text-mil-dim" /> : null}
              </div>
              {previewError ? <p className="text-xs text-red-300">{previewError}</p> : null}
              {preview ? (
                <>
                  <p className="text-xs text-mil-muted">
                    {preview.mod_count_before} → <span className="text-mil-fg">{preview.mod_count_after}</span> mods
                    {diff?.version_changed_count ? ` · ${diff.version_changed_count} version change(s)` : ''}
                    {diff?.enabled_changed_count ? ` · ${diff.enabled_changed_count} enabled/disabled change(s)` : ''}
                  </p>
                  {noChanges ? <p className="text-xs text-emerald-300/90">Already identical; nothing would change.</p> : null}
                  <DiffList title="added" items={diff?.added} tone="text-emerald-300" icon={Plus} />
                  <DiffList title="removed" items={diff?.removed} tone="text-red-300" icon={Minus} />
                  {preview.scenario_warning ? (
                    <div className="flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-xs text-red-200">
                      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                      <span>{preview.scenario_warning.message}</span>
                    </div>
                  ) : null}
                </>
              ) : null}
            </div>
          ) : null}
        </div>
      </section>

      <section className="space-y-3 rounded-xl border border-white/[0.07] bg-mil-bg-panel/70 p-4">
        <h3 className="text-xs font-semibold text-mil-soft">Options</h3>
        {OPTIONS.map(([key, label, help]) => (
          <div key={key} className="flex items-start justify-between gap-3 rounded-lg border border-white/[0.06] bg-black/20 p-3">
            <div>
              <p className="text-sm text-mil-fg">{label}</p>
              <p className="mt-0.5 text-[11px] text-mil-dim">{help}</p>
            </div>
            <Switch
              checked={options[key]}
              onCheckedChange={(value) => setOptions((prev) => ({ ...prev, [key]: value }))}
              className="mt-0.5 h-5 w-9"
              aria-label={label}
            />
          </div>
        ))}
        <label className="block space-y-1.5">
          <span className="text-xs font-medium text-mil-muted">After pulling</span>
          <select
            value={afterPull}
            onChange={(event) => setAfterPull(event.target.value)}
            className="h-9 w-full rounded-md border border-white/10 bg-mil-bg-deep/60 px-2 text-xs text-mil-muted"
          >
            <option value="none">Leave this server as it is</option>
            <option value="restart">Restart this server</option>
            <option value="reconfigure">Reconfigure this server</option>
          </select>
        </label>
        <Button
          onClick={() => setConfirmOpen(true)}
          disabled={!canManage || dirty || !sourceId || running || noChanges}
          className="w-full gap-2 bg-brand text-black hover:bg-brand-light"
        >
          {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowDownToLine className="h-4 w-4" />}
          {source ? `Pull from ${source.name || source.id}` : 'Pick a server to pull from'}
        </Button>
      </section>

      <Dialog open={confirmOpen} onOpenChange={(open) => { if (!running) setConfirmOpen(open); }}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Replace this server's load order?</DialogTitle>
            <DialogDescription>
              {server?.name || serverId} will get the saved load order of {source?.name || sourceId}
              {diff ? ` (+${diff.added_count} / −${diff.removed_count})` : ''}.
              {options.create_backups ? ' A backup is taken first.' : ''}
            </DialogDescription>
          </DialogHeader>
          {preview?.scenario_warning ? (
            <p className="flex items-start gap-2 rounded-md border border-red-500/30 bg-red-500/10 p-3 text-xs text-red-200">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /> {preview.scenario_warning.message}
            </p>
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmOpen(false)} disabled={running}>Cancel</Button>
            <Button onClick={executePull} disabled={running} className="gap-2">
              {running ? <Loader2 className="h-4 w-4 animate-spin" /> : null} Replace load order
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
