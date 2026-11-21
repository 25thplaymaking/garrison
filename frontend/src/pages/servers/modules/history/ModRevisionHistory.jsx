import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowLeftRight,
  ChevronDown,
  ChevronRight,
  History,
  Loader2,
  Package,
  Power,
  Search,
  MoveVertical,
} from 'lucide-react';
import apiClient from '@/lib/apiClient';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { toast } from '@/hooks/use-toast';
import { filterRevisions, revisionSearchText } from './revisionFilters';
import { formatApiError } from '@/utils/errorMessages';
import useConfirmDialog from '@/hooks/useConfirmDialog';

/**
 * Mod loadout change history.
 *
 * Replaces a read-only list that showed counts and a comma-joined set of names.
 * The gaps it closes, in the order they were asked for: what exactly changed
 * (mod ids, enable/disable, and which mods moved position), what the loadout
 * actually looked like at a point in time, and how two points differ.
 *
 * Paged, because the list endpoint used to cap at 200 and the busiest server
 * already had 225 revisions — its 25 oldest were unreachable.
 */

const PAGE_SIZE = 50;

const SOURCE_LABELS = {
  deploy: 'Deploy',
  import: 'Import',
  mirror: 'Mirror',
};

function sourceLabel(source) {
  if (SOURCE_LABELS[source]) return SOURCE_LABELS[source];
  if (typeof source === 'string' && source.startsWith('revert')) return 'Revert';
  return source || 'Unknown';
}

function formatWhen(value) {
  if (!value) return 'Unknown time';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? 'Unknown time' : parsed.toLocaleString();
}

/** One mod line inside an expanded revision. */
function ModLine({ icon: Icon, tone, children, modId }) {
  return (
    <div className="flex items-start gap-2 py-0.5">
      <Icon className={`mt-0.5 h-3 w-3 shrink-0 ${tone}`} />
      <span className="min-w-0 flex-1 text-[11px] text-mil-fg">{children}</span>
      {modId && (
        <code className="shrink-0 font-mono text-[11px] text-mil-dim">{modId}</code>
      )}
    </div>
  );
}

function RevisionDetail({ diff }) {
  const d = diff || {};
  const nothing =
    !d.added?.length && !d.removed?.length && !d.version_changed?.length
    && !d.enabled_changed?.length && !d.moved?.length;

  if (nothing) {
    return (
      <p className="py-1 text-[11px] text-mil-dim">
        {d.reordered
          ? 'Load order changed. This revision predates per-mod move tracking, so the exact positions were not recorded.'
          : 'No per-mod detail was recorded for this revision.'}
      </p>
    );
  }

  return (
    <div className="space-y-0.5">
      {d.added?.map((m) => (
        <ModLine key={`a-${m.mod_id}`} icon={Package} tone="text-emerald-400" modId={m.mod_id}>
          <span className="text-emerald-300">Added</span> {m.name}
        </ModLine>
      ))}
      {d.removed?.map((m) => (
        <ModLine key={`r-${m.mod_id}`} icon={Package} tone="text-red-400" modId={m.mod_id}>
          <span className="text-red-300">Removed</span> {m.name}
        </ModLine>
      ))}
      {d.version_changed?.map((m) => (
        <ModLine key={`v-${m.mod_id}`} icon={Package} tone="text-blue-400" modId={m.mod_id}>
          <span className="text-blue-300">Version</span> {m.name}{' '}
          <span className="font-mono text-[11px]">
            {m.from || 'latest'} → {m.to || 'latest'}
          </span>
        </ModLine>
      ))}
      {d.enabled_changed?.map((m) => (
        <ModLine key={`e-${m.mod_id}`} icon={Power} tone="text-amber-400" modId={m.mod_id}>
          <span className="text-amber-300">{m.enabled ? 'Enabled' : 'Disabled'}</span> {m.name}
        </ModLine>
      ))}
      {d.moved?.map((m) => (
        <ModLine key={`m-${m.mod_id}`} icon={MoveVertical} tone="text-purple-400" modId={m.mod_id}>
          <span className="text-purple-300">Moved</span> {m.name}{' '}
          <span className="font-mono text-[11px]">pos {m.from} → {m.to}</span>
        </ModLine>
      ))}
    </div>
  );
}

function ModRevisionHistory({ serverId, serverName, canManage, user, onReverted }) {
  const { confirm, dialog: confirmDialog } = useConfirmDialog();

  const [revisions, setRevisions] = useState([]);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');

  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState(() => new Set());
  const [revertingVersion, setRevertingVersion] = useState(null);

  // Loadout-at-revision, keyed by version so reopening is instant.
  const [snapshots, setSnapshots] = useState({});
  const [snapshotLoading, setSnapshotLoading] = useState(null);

  // Compare mode: pick a base, then a target.
  const [compareBase, setCompareBase] = useState(null);
  const [comparison, setComparison] = useState(null);
  const [comparing, setComparing] = useState(false);

  const fetchPage = useCallback(async (offset) => {
    const res = await apiClient.get(`/servers/${serverId}/mods/revisions`, {
      params: { limit: PAGE_SIZE, offset },
    });
    const data = res.data || {};
    // Tolerate the pre-pagination array shape so a stale frontend against a
    // new backend (or the reverse) still renders something.
    if (Array.isArray(data)) return { items: data, total: data.length, has_more: false };
    return { items: data.items || [], total: data.total || 0, has_more: !!data.has_more };
  }, [serverId]);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const { items, total: t, has_more } = await fetchPage(0);
      setRevisions(items);
      setTotal(t);
      setHasMore(has_more);
    } catch {
      setRevisions([]);
      setError('Could not load the loadout history.');
    } finally {
      setLoading(false);
    }
  }, [fetchPage]);

  useEffect(() => { load(); }, [load]);

  const loadMore = useCallback(async () => {
    setLoadingMore(true);
    try {
      const { items, has_more } = await fetchPage(revisions.length);
      setRevisions((prev) => [...prev, ...items]);
      setHasMore(has_more);
    } catch {
      setError('Could not load more revisions.');
    } finally {
      setLoadingMore(false);
    }
  }, [fetchPage, revisions.length]);

  const visible = useMemo(() => filterRevisions(revisions, query), [revisions, query]);

  const toggleExpanded = useCallback((version) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(version)) next.delete(version);
      else next.add(version);
      return next;
    });
  }, []);

  const loadSnapshot = useCallback(async (version) => {
    if (snapshots[version]) {
      setSnapshots((prev) => ({ ...prev, [version]: { ...prev[version], open: !prev[version].open } }));
      return;
    }
    setSnapshotLoading(version);
    try {
      const res = await apiClient.get(`/servers/${serverId}/mods/revisions/${version}`);
      setSnapshots((prev) => ({
        ...prev,
        [version]: { mods: res.data?.after_mods || [], open: true },
      }));
    } catch {
      toast({ title: 'Could not load that loadout', description: `Revision ${version} could not be read.` });
    } finally {
      setSnapshotLoading(null);
    }
  }, [serverId, snapshots]);

  const runCompare = useCallback(async (target) => {
    if (compareBase === null || compareBase === target) return;
    setComparing(true);
    try {
      const res = await apiClient.get(
        `/servers/${serverId}/mods/revisions/${compareBase}/compare/${target}`,
      );
      setComparison(res.data);
    } catch (err) {
      toast({
        title: 'Compare failed',
        description: formatApiError(err, 'Could not compare those revisions.'),
      });
    } finally {
      setComparing(false);
      setCompareBase(null);
    }
  }, [compareBase, serverId]);

  const handleRevert = useCallback(async (version) => {
    // One click used to replace the deployed loadout (and drop any unsaved
    // load-order draft in the Mods tab).
    if (!(await confirm({
      title: `Revert to Revision ${version}`,
      description: `Replace ${serverName || 'this server'}'s deployed mods with revision ${version}? Unsaved load-order edits are discarded. The current list is kept as a new revision.`,
      destructive: true,
      confirmLabel: 'Revert loadout',
    }))) {
      return;
    }
    setRevertingVersion(version);
    try {
      await apiClient.post(
        `/servers/${serverId}/mods/revisions/${version}/revert`, {},
        { validateStatus: (s) => s < 400,},
      );
      await onReverted?.();
      await load();
      toast({
        title: 'Loadout reverted',
        description: `Restored the mod loadout to revision ${version}.`,
      });
    } catch (error) {
      toast({
        title: 'Revert failed',
        description: formatApiError(error, 'Could not revert the mod loadout.'),
      });
    } finally {
      setRevertingVersion(null);
    }
  }, [confirm, load, onReverted, serverId, serverName, user]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-6 w-6 animate-spin text-brand" />
      </div>
    );
  }

  if (revisions.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-10 text-center text-mil-dim">
        <History className="mb-2 h-7 w-7 text-mil-dim" />
        <p className="text-sm">{error || 'No mod changes recorded yet.'}</p>
        <p className="mt-1 text-xs">Deploys, imports, mirrors, and reverts will appear here going forward.</p>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      {confirmDialog}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[12rem] flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-mil-dim" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search by mod name, person, or source"
            aria-label="Search the loadout history"
            className="h-8 border-zinc-700 bg-mil-bg-deep/70 pl-8 text-xs text-white placeholder:text-mil-dim"
          />
        </div>
        <span className="text-[11px] text-mil-dim">
          {query.trim() ? `${visible.length} of ${revisions.length} loaded` : `${revisions.length} of ${total}`}
        </span>
      </div>

      {compareBase !== null && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-brand/30 bg-brand/5 p-2 text-[11px] text-mil-fg">
          <ArrowLeftRight className="h-3.5 w-3.5 text-brand" />
          Comparing from revision {compareBase} — pick a second revision.
          <Button
            size="sm" variant="ghost"
            onClick={() => setCompareBase(null)}
            className="ml-auto h-6 text-[11px] text-mil-muted"
          >
            Cancel
          </Button>
        </div>
      )}

      {comparison && (
        <div className="rounded-lg border border-zinc-700 bg-mil-bg-deep/60 p-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-semibold text-mil-fg">
              Revision {comparison.base?.version} → {comparison.target?.version}
            </span>
            <Button
              size="sm" variant="ghost"
              onClick={() => setComparison(null)}
              className="ml-auto h-6 text-[11px] text-mil-muted"
            >
              Close
            </Button>
          </div>
          <div className="mt-2">
            <RevisionDetail diff={comparison.diff} />
          </div>
        </div>
      )}

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
        {visible.length === 0 ? (
          <div className="py-8 text-center text-xs text-mil-dim">
            No revisions match “{query.trim()}”.
            {hasMore && ' Older revisions may not be loaded yet.'}
          </div>
        ) : visible.map((rev) => {
          const d = rev.diff || {};
          const isCurrent = rev.version === revisions[0]?.version;
          const isOpen = expanded.has(rev.version);
          const snapshot = snapshots[rev.version];
          return (
            <div key={rev.id || rev.version} className="rounded-lg border border-zinc-800/70 bg-mil-bg-deep/40 p-3">
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => toggleExpanded(rev.version)}
                  className="flex items-center gap-1 text-sm font-semibold text-mil-fg hover:text-brand"
                  aria-expanded={isOpen}
                >
                  {isOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                  Revision {rev.version}
                </button>
                <Badge variant="outline" className="border-zinc-700 text-[11px] text-mil-muted capitalize">
                  {sourceLabel(rev.source)}
                </Badge>
                {isCurrent && (
                  <Badge variant="outline" className="border-emerald-600/30 text-[11px] text-emerald-300">Current</Badge>
                )}
                {typeof rev.mod_count === 'number' && (
                  <span className="text-[11px] text-mil-dim">{rev.mod_count} mods</span>
                )}
                <span className="ml-auto text-[11px] text-mil-dim">
                  {rev.changed_by_name} · {formatWhen(rev.changed_at)}
                </span>
              </div>

              <div className="mt-2 flex flex-wrap gap-1.5">
                {d.added_count > 0 && <Badge variant="outline" className="border-emerald-600/30 text-[11px] text-emerald-300">+{d.added_count} added</Badge>}
                {d.removed_count > 0 && <Badge variant="outline" className="border-red-600/30 text-[11px] text-red-300">−{d.removed_count} removed</Badge>}
                {d.version_changed_count > 0 && <Badge variant="outline" className="border-blue-600/30 text-[11px] text-blue-300">{d.version_changed_count} version{d.version_changed_count === 1 ? '' : 's'}</Badge>}
                {d.enabled_changed_count > 0 && <Badge variant="outline" className="border-amber-600/30 text-[11px] text-amber-300">{d.enabled_changed_count} toggled</Badge>}
                {d.moved_count > 0 && <Badge variant="outline" className="border-purple-600/30 text-[11px] text-purple-300">{d.moved_count} moved</Badge>}
                {!d.moved_count && d.reordered && <Badge variant="outline" className="border-purple-600/30 text-[11px] text-purple-300">reordered</Badge>}
              </div>

              {isOpen && (
                <div className="mt-2 border-t border-zinc-800/70 pt-2">
                  <RevisionDetail diff={d} />

                  {snapshot?.open && (
                    <div className="mt-2 rounded border border-zinc-800 bg-zinc-950/60 p-2">
                      <p className="mb-1 text-xs text-mil-muted font-medium capitalize">
                        Loadout at revision {rev.version} — {snapshot.mods.length} mods
                      </p>
                      <ol className="max-h-52 space-y-0.5 overflow-y-auto">
                        {snapshot.mods.map((m, i) => (
                          <li key={m.mod_id || i} className="flex gap-2 text-[11px] text-mil-muted">
                            <span className="w-6 shrink-0 text-right text-mil-dim">{i + 1}</span>
                            <span className={`min-w-0 flex-1 truncate ${m.enabled === false ? 'line-through opacity-60' : ''}`}>
                              {m.name || m.mod_id}
                            </span>
                          </li>
                        ))}
                      </ol>
                    </div>
                  )}
                </div>
              )}

              <div className="mt-2.5 flex flex-wrap justify-end gap-2">
                <Button
                  size="sm" variant="outline"
                  onClick={() => loadSnapshot(rev.version)}
                  disabled={snapshotLoading === rev.version}
                  className="h-7 border-zinc-700 text-[11px] text-mil-muted hover:border-brand/40 hover:text-brand"
                >
                  {snapshotLoading === rev.version
                    ? <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                    : <Package className="mr-1 h-3 w-3" />}
                  {snapshot?.open ? 'Hide loadout' : 'View loadout'}
                </Button>
                <Button
                  size="sm" variant="outline"
                  onClick={() => (compareBase === null ? setCompareBase(rev.version) : runCompare(rev.version))}
                  disabled={comparing || compareBase === rev.version}
                  className="h-7 border-zinc-700 text-[11px] text-mil-muted hover:border-brand/40 hover:text-brand"
                >
                  <ArrowLeftRight className="mr-1 h-3 w-3" />
                  {compareBase === null ? 'Compare…' : `Compare to ${compareBase}`}
                </Button>
                <Button
                  size="sm" variant="outline"
                  onClick={() => handleRevert(rev.version)}
                  disabled={isCurrent || !canManage || revertingVersion !== null}
                  className="h-7 border-zinc-700 text-[11px] text-mil-muted hover:border-brand/40 hover:text-brand disabled:opacity-40"
                  title={isCurrent ? 'This is the current loadout' : `Restore the loadout to revision ${rev.version}`}
                >
                  {revertingVersion === rev.version
                    ? <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                    : <History className="mr-1 h-3 w-3" />}
                  Revert to this
                </Button>
              </div>
            </div>
          );
        })}

        {hasMore && (
          <div className="pb-2 text-center">
            <Button
              size="sm" variant="outline"
              onClick={loadMore}
              disabled={loadingMore}
              className="h-7 border-zinc-700 text-[11px] text-mil-muted hover:border-brand/40 hover:text-brand"
            >
              {loadingMore && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}
              Load older revisions ({total - revisions.length} remaining)
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

export { revisionSearchText };
export default ModRevisionHistory;
