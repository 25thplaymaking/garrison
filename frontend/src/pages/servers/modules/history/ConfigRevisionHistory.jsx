import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { CommandEmptyState, CommandLoadingState } from '@/components/tactical/CommandUI';
import { useOutletContext } from 'react-router';
import {
  ChevronDown,
  ChevronRight,
  History,
  Loader2,
  Minus,
  Pencil,
  Plus,
  Search,
} from 'lucide-react';
import apiClient from '@/lib/apiClient';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { toast } from '@/hooks/use-toast';
import { formatApiError } from '@/utils/errorMessages';

/**
 * Server config change history.
 *
 * The backend has recorded config changes since long before this existed, but
 * nothing ever rendered them: entries were raw pre-change snapshots with no
 * diff, stored in an array on the server document. They now live in their own
 * collection with a dotted-path diff per version, which is what this shows.
 */

const PAGE_SIZE = 50;

function formatWhen(value) {
  if (!value) return 'Unknown time';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? 'Unknown time' : parsed.toLocaleString();
}

/** Match a revision against a query, including the paths it touched. */
export function filterConfigRevisions(revisions, query) {
  const list = Array.isArray(revisions) ? revisions : [];
  const trimmed = String(query ?? '').trim().toLowerCase();
  if (!trimmed) return list;
  const terms = trimmed.split(/\s+/);
  return list.filter((rev) => {
    const d = rev?.diff || {};
    const paths = [
      ...(d.added || []), ...(d.removed || []), ...(d.changed || []),
    ].map((entry) => entry.path).join(' ');
    const text = [
      `revision ${rev?.version ?? ''}`, rev?.source, rev?.changed_by_name, paths,
    ].filter(Boolean).join(' ').toLowerCase();
    return terms.every((term) => text.includes(term));
  });
}

function DiffRows({ diff }) {
  const d = diff || {};
  const nothing = !d.added?.length && !d.removed?.length && !d.changed?.length;
  if (nothing) {
    return <p className="py-1 text-[11px] text-mil-dim">No field-level detail recorded.</p>;
  }
  return (
    <div className="space-y-0.5">
      {d.changed?.map((entry) => (
        <div key={`c-${entry.path}`} className="flex items-start gap-2 py-0.5 text-[11px]">
          <Pencil className="mt-0.5 h-3 w-3 shrink-0 text-blue-400" />
          <code className="min-w-0 flex-1 break-all font-mono text-[11px] text-mil-fg">{entry.path}</code>
          <span className="shrink-0 font-mono text-[11px] text-mil-muted">
            <span className="text-red-300">{entry.from}</span>
            {' → '}
            <span className="text-emerald-300">{entry.to}</span>
          </span>
        </div>
      ))}
      {d.added?.map((entry) => (
        <div key={`a-${entry.path}`} className="flex items-start gap-2 py-0.5 text-[11px]">
          <Plus className="mt-0.5 h-3 w-3 shrink-0 text-emerald-400" />
          <code className="min-w-0 flex-1 break-all font-mono text-[11px] text-mil-fg">{entry.path}</code>
          <span className="shrink-0 font-mono text-[11px] text-emerald-300">{entry.value}</span>
        </div>
      ))}
      {d.removed?.map((entry) => (
        <div key={`r-${entry.path}`} className="flex items-start gap-2 py-0.5 text-[11px]">
          <Minus className="mt-0.5 h-3 w-3 shrink-0 text-red-400" />
          <code className="min-w-0 flex-1 break-all font-mono text-[11px] text-mil-fg">{entry.path}</code>
          <span className="shrink-0 font-mono text-[11px] text-red-300">{entry.value}</span>
        </div>
      ))}
    </div>
  );
}

function ConfigRevisionHistory() {
  const { server, serverId, canManage, user, fetchServer } = useOutletContext();

  const [revisions, setRevisions] = useState([]);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState(() => new Set());
  const [reverting, setReverting] = useState(null);

  const fetchPage = useCallback(async (offset) => {
    const res = await apiClient.get(`/servers/${serverId}/config/history`, {
      params: { limit: PAGE_SIZE, offset },
    });
    const data = res.data || {};
    if (Array.isArray(data)) return { items: data, total: data.length, has_more: false };
    return { items: data.items || [], total: data.total || 0, has_more: !!data.has_more };
  }, [serverId]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { items, total: t, has_more } = await fetchPage(0);
      setRevisions(items);
      setTotal(t);
      setHasMore(has_more);
    } catch {
      setRevisions([]);
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
    } finally {
      setLoadingMore(false);
    }
  }, [fetchPage, revisions.length]);

  const visible = useMemo(() => filterConfigRevisions(revisions, query), [revisions, query]);

  const toggle = useCallback((version) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(version)) next.delete(version);
      else next.add(version);
      return next;
    });
  }, []);

  const handleRevert = useCallback(async (version) => {
    setReverting(version);
    try {
      await apiClient.post(
        `/servers/${serverId}/config/history/${version}/revert`, {},
        { validateStatus: (s) => s < 400,},
      );
      await fetchServer?.(true);
      await load();
      toast({ title: 'Config reverted', description: `Restored the config to revision ${version}.` });
    } catch (error) {
      toast({
        title: 'Revert failed',
        description: formatApiError(error, 'Could not revert the server config.'),
      });
    } finally {
      setReverting(null);
    }
  }, [fetchServer, load, server?.name, serverId, user]);

  if (loading) {
    return <CommandLoadingState immersive={false} label="Loading config history" rows={3} />;
  }

  if (revisions.length === 0) {
    return (
      <CommandEmptyState icon={History} title="No config changes recorded yet" description="Edits to this server's configuration will appear here." />
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[12rem] flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-mil-dim" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search by setting path, person, or source"
            aria-label="Search the config history"
            className="h-8 border-zinc-700 bg-mil-bg-deep/70 pl-8 text-xs text-white placeholder:text-mil-dim"
          />
        </div>
        <span className="text-[11px] text-mil-dim">
          {query.trim() ? `${visible.length} of ${revisions.length} loaded` : `${revisions.length} of ${total}`}
        </span>
      </div>

      {visible.length === 0 ? (
        <p className="py-8 text-center text-xs text-mil-dim">No revisions match “{query.trim()}”.</p>
      ) : visible.map((rev, idx) => {
        const isCurrent = idx === 0 && !query.trim();
        const isOpen = expanded.has(rev.version);
        const d = rev.diff || {};
        return (
          <div key={rev.id || rev.version} className="rounded-lg border border-zinc-800/70 bg-mil-bg-deep/40 p-3">
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => toggle(rev.version)}
                className="flex items-center gap-1 text-sm font-semibold text-mil-fg hover:text-brand"
                aria-expanded={isOpen}
              >
                {isOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                Revision {rev.version}
              </button>
              <Badge variant="outline" className="border-zinc-700 text-[11px] text-mil-muted capitalize">
                {rev.source || 'update'}
              </Badge>
              {isCurrent && (
                <Badge variant="outline" className="border-emerald-600/30 text-[11px] text-emerald-300">Current</Badge>
              )}
              <span className="ml-auto text-[11px] text-mil-dim">
                {rev.changed_by_name || rev.changed_by || 'Unknown'} · {formatWhen(rev.changed_at)}
              </span>
            </div>

            <div className="mt-2 flex flex-wrap gap-1.5">
              {d.changed_count > 0 && <Badge variant="outline" className="border-blue-600/30 text-[11px] text-blue-300">{d.changed_count} changed</Badge>}
              {d.added_count > 0 && <Badge variant="outline" className="border-emerald-600/30 text-[11px] text-emerald-300">+{d.added_count} added</Badge>}
              {d.removed_count > 0 && <Badge variant="outline" className="border-red-600/30 text-[11px] text-red-300">−{d.removed_count} removed</Badge>}
            </div>

            {isOpen && (
              <div className="mt-2 border-t border-zinc-800/70 pt-2">
                <DiffRows diff={d} />
              </div>
            )}

            <div className="mt-2.5 flex justify-end">
              <Button
                size="sm" variant="outline"
                onClick={() => handleRevert(rev.version)}
                disabled={isCurrent || !canManage || reverting !== null}
                className="h-7 border-zinc-700 text-[11px] text-mil-muted hover:border-brand/40 hover:text-brand disabled:opacity-40"
                title={isCurrent ? 'This is the current config' : `Restore the config to revision ${rev.version}`}
              >
                {reverting === rev.version
                  ? <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                  : <History className="mr-1 h-3 w-3" />}
                Revert to this
              </Button>
            </div>
          </div>
        );
      })}

      {hasMore && (
        <div className="text-center">
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
  );
}

export default ConfigRevisionHistory;
