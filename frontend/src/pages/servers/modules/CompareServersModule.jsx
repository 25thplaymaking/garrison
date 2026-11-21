import React, { useCallback, useMemo, useState } from 'react';
import { useOutletContext } from 'react-router';
import apiClient from '@/lib/apiClient';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import {
  ArrowRight,
  CheckCircle,
  ChevronDown,
  ChevronUp,
  Copy,
  ExternalLink,
  Globe,
  Loader2,
  Lock,
  Package,
  Search,
  Server,
  Shield,
  Users,
} from 'lucide-react';
import { API } from '@/utils/api';
import { formatApiError } from '@/utils/errorMessages';
import useConfirmDialog from '@/hooks/useConfirmDialog';

/* ── Helpers ──────────────────────────────────────────────────────────────── */

function statusBadge(status) {
  if (status === 'online') return 'border-green-600/40 text-green-400 bg-green-900/20';
  if (status === 'offline') return 'border-zinc-600/40 text-zinc-400 bg-zinc-900/20';
  return 'border-amber-600/40 text-amber-300 bg-amber-900/20';
}

// The public server list is ReforgerMods (free, no key), which replaced
// BattleMetrics once BattleMetrics' API needed a paid subscription.
const DEFAULT_PAGE_SIZE = 10;
const LIST_SITE = 'https://reforgermods.net';
const WORKSHOP_MOD = 'https://reforger.armaplatform.com/workshop/';

// The free list searches names, not addresses: say so when an IP is typed.
const IP_RE = /^\d{1,3}(\.\d{1,3}){3}(:\d{1,5})?$/;

// Bohemia's ping sites, which the list reports as a server's region.
const REGIONS = [
  ['', 'Any'],
  ['new_york', 'New York'],
  ['miami', 'Miami'],
  ['los_angeles', 'Los Angeles'],
  ['london', 'London'],
  ['frankfurt', 'Frankfurt'],
  ['singapore', 'Singapore'],
  ['sydney', 'Sydney'],
];
const regionLabel = (value) => REGIONS.find(([v]) => v === value)?.[1] || value || '';

/* ── Main component ───────────────────────────────────────────────────────── */

function CompareServersModule() {
  const { server, serverId, canManage, fetchServer, user } = useOutletContext();
  const { confirm, dialog: confirmDialog } = useConfirmDialog();

  /* search state */
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState(null);
  const [paging, setPaging] = useState(null); // { page, total_pages, total, has_next, has_prev }
  const [searchedFor, setSearchedFor] = useState('');
  const [sortBy, setSortBy] = useState('players');
  const [regionFilter, setRegionFilter] = useState('');
  const [includeOffline, setIncludeOffline] = useState(false);
  // Mirroring is about mod lists, so modded servers are the default.
  const [moddedOnly, setModdedOnly] = useState(true);

  /* selected server state */
  const [selected, setSelected] = useState(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [detailError, setDetailError] = useState(null);

  /* copy state */
  const [copying, setCopying] = useState(false);
  const [copySuccess, setCopySuccess] = useState(false);

  /* comparison visibility */
  const [showComparison, setShowComparison] = useState(true);

  /* ── search ────────────────────────────────────────────────────────────── */

  const doSearch = useCallback(async (searchQuery, page) => {
    setSearching(true);
    setSearchError(null);
    try {
      const params = {
        per_page: DEFAULT_PAGE_SIZE,
        page,
        sort: sortBy,
        include_offline: includeOffline,
        modded_only: moddedOnly,
      };
      if (searchQuery) params.q = searchQuery;
      if (regionFilter) params.region = regionFilter;
      const res = await apiClient.get('/servers/server-list/search', { params });
      setResults(res.data.servers || []);
      setPaging(res.data);
      setSearchedFor(searchQuery);
    } catch (err) {
      setSearchError(formatApiError(err, 'Search failed'));
      setResults([]);
      setPaging(null);
    } finally {
      setSearching(false);
    }
  }, [sortBy, includeOffline, moddedOnly, regionFilter]);

  const handleSearch = useCallback((e) => {
    e?.preventDefault?.();
    setSelected(null);
    doSearch(query.trim(), 1);
  }, [query, doSearch]);

  const handleNextPage = useCallback(() => {
    if (paging?.has_next) doSearch(searchedFor, paging.page + 1);
  }, [paging, searchedFor, doSearch]);

  const handlePrevPage = useCallback(() => {
    if (paging?.has_prev) doSearch(searchedFor, paging.page - 1);
  }, [paging, searchedFor, doSearch]);

  /* ── select a server ───────────────────────────────────────────────────── */

  const handleSelect = useCallback(async (listServer) => {
    setLoadingDetail(true);
    setDetailError(null);
    setSelected(null);
    setCopySuccess(false);
    try {
      const res = await apiClient.get(`/servers/server-list/${listServer.id}`);
      setSelected(res.data);
    } catch (err) {
      setDetailError(formatApiError(err, 'Failed to load server details'));
    } finally {
      setLoadingDetail(false);
    }
  }, []);

  /* ── copy mods ─────────────────────────────────────────────────────────── */

  const handleCopyMods = useCallback(async () => {
    if (!selected || !canManage) return;

    const remoteMods = selected.mods || [];
    if (remoteMods.length === 0) return;

    // No version pins: the list reports whatever that server last
    // advertised, and a pin to a version later pulled from the Workshop stops
    // the server booting ("Addon not found on workshop"). Latest is what the
    // Mods tab adds by default too.
    const modsPayload = remoteMods.map((mod) => ({
      mod_id: mod.mod_id,
      modId: mod.mod_id,
      name: mod.name || mod.mod_id,
      version: '',
      enabled: true,
    }));

    if (!(await confirm({
      title: 'Replace Server Mod List',
      description: `Replace ${server?.name || 'this server'}'s deployed mods with the ${remoteMods.length} mods from ${selected.name || 'the selected server'}? The current list stays in mod history.`,
      destructive: true,
      confirmLabel: 'Replace mod list',
    }))) {
      return;
    }

    setCopying(true);
    setCopySuccess(false);
    try {
      await apiClient.post(`/servers/${serverId}/mods/import-json`, {
        mods: modsPayload,
      }, {
        validateStatus: (status) => status < 400,
      });
      setCopySuccess(true);
      if (fetchServer) await fetchServer(true);
    } catch (err) {
      setDetailError(formatApiError(err, 'Failed to import mods'));
    } finally {
      setCopying(false);
    }
  }, [canManage, confirm, fetchServer, selected, server?.name, serverId, user]);

  /* ── local mods for comparison ─────────────────────────────────────────── */

  const localMods = useMemo(() => {
    if (!server?.mods) return [];
    return server.mods.filter((m) => m.enabled !== false);
  }, [server?.mods]);

  const localModIds = useMemo(() => new Set(localMods.map((m) => m.mod_id || m.modId || '')), [localMods]);

  /* ── render ────────────────────────────────────────────────────────────── */

  return (
    <div className="flex flex-col gap-6">
      {confirmDialog}
      {/* ── Hero banner ─────────────────────────────────────────────────── */}
      <div className="relative overflow-hidden corner-bracket c2-corner-live rounded-lg border border-[rgba(232,131,58,0.15)] backdrop-blur-sm p-6 bg-mil-bg-card">
        <p className="mb-1 font-condensed text-xs text-brand font-medium">
          Intelligence
        </p>
        <h1 className="font-heading text-2xl font-bold text-brand-light">
          Compare Servers
        </h1>
        <p className="mt-1 font-body text-sm text-mil-muted">
          Search the public Arma Reforger server list. Compare a server&apos;s mods with this one, then mirror its whole mod list with one click.
        </p>
      </div>

      {/* ── Search bar ──────────────────────────────────────────────────── */}
      <form onSubmit={handleSearch} className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-mil-dim" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Server or scenario name, or paste a reforgermods.net server link…"
            aria-label="Search public servers"
            className="h-10 border-zinc-800 bg-mil-bg-deep/60 pl-10 text-sm text-white placeholder:text-mil-dim"
          />
        </div>
        <Button
          type="submit"
          disabled={searching}
          className="h-10 bg-[rgba(232,131,58,0.15)] text-brand-light hover:bg-[rgba(232,131,58,0.25)]"
        >
          {searching ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Search className="mr-2 h-4 w-4" />}
          Search
        </Button>
      </form>

      {/* ── Filters ─────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-3 text-xs">
        <div className="flex items-center gap-1.5">
          <span className="text-mil-dim">Sort:</span>
          <select
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value)}
            className="h-7 rounded border border-zinc-800 bg-mil-bg-deep/60 px-2 text-xs text-mil-muted"
          >
            <option value="players">Most players</option>
            <option value="name">Name (A → Z)</option>
            <option value="newest">Newest</option>
            <option value="lastSeen">Recently seen</option>
          </select>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-mil-dim">Region:</span>
          <select
            value={regionFilter}
            onChange={(e) => setRegionFilter(e.target.value)}
            aria-label="Region"
            className="h-7 rounded border border-zinc-800 bg-mil-bg-deep/60 px-2 text-xs text-mil-muted"
          >
            {REGIONS.map(([value, label]) => <option key={value || 'any'} value={value}>{label}</option>)}
          </select>
        </div>
        <label className="flex min-h-7 items-center gap-1.5 text-mil-muted">
          <input type="checkbox" checked={moddedOnly} onChange={(e) => setModdedOnly(e.target.checked)} className="accent-red-500" />
          Modded only
        </label>
        <label className="flex min-h-7 items-center gap-1.5 text-mil-muted">
          <input type="checkbox" checked={includeOffline} onChange={(e) => setIncludeOffline(e.target.checked)} className="accent-red-500" />
          Include offline
        </label>
      </div>

      {/* The free list has no address search */}
      {query && IP_RE.test(query.trim()) && (
        <p className="text-xs text-mil-muted">
          <span className="text-brand font-medium">Addresses aren&apos;t searchable:</span> the free server list
          searches names. Search the server&apos;s name, or open it on{' '}
          <a href={`${LIST_SITE}/servers`} target="_blank" rel="noopener noreferrer" className="text-brand hover:underline">reforgermods.net</a>{' '}
          and paste its link here.
        </p>
      )}

      {searchError && (
        <p className="text-sm text-red-400">{searchError}</p>
      )}

      {/* ── Layout: results + detail ────────────────────────────────────── */}
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
        {/* Left — search results */}
        <div className="flex flex-col gap-3">
          {results.length > 0 && (
            <h2 className="font-heading text-sm font-semibold text-mil-muted">
              Search Results {searchedFor && <span className="font-normal text-mil-dim">for &ldquo;{searchedFor}&rdquo;</span>}
            </h2>
          )}
          {results.map((srv) => (
            <Card
              key={srv.id}
              className={`cursor-pointer border-zinc-800 bg-mil-bg-panel transition-colors hover:border-[rgba(232,131,58,0.3)] ${
                selected?.id === srv.id ? 'border-[rgba(232,131,58,0.5)] bg-[rgba(232,131,58,0.04)]' : ''
              }`}
              role="button"
              tabIndex={0}
              aria-pressed={selected?.id === srv.id}
              onClick={() => handleSelect(srv)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  handleSelect(srv);
                }
              }}
            >
              <CardContent className="flex items-center gap-4 p-4">
                <Server className="h-5 w-5 shrink-0 text-mil-dim" />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-heading text-sm font-semibold text-white">{srv.name}</p>
                  <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-mil-muted">
                    <span className="flex items-center gap-1"><Users className="h-3 w-3" />{srv.players}/{srv.max_players}</span>
                    {srv.scenario && <span>• {srv.scenario}</span>}
                    <span>• {srv.mod_count ? `${srv.mod_count} mods` : 'No mods'}</span>
                    {srv.region && <span className="flex items-center gap-1"><Globe className="h-3 w-3" />{regionLabel(srv.region)}</span>}
                  </div>
                </div>
                <Badge variant="outline" className={`capitalize shrink-0 text-[11px] ${statusBadge(srv.status)}`}>
                  {srv.status}
                </Badge>
              </CardContent>
            </Card>
          ))}

          {/* Pagination */}
          {results.length > 0 && (
            <>
              <div className="flex items-center justify-between rounded-lg border border-zinc-800 bg-mil-bg-panel px-4 py-2 text-xs text-mil-dim">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!paging?.has_prev || searching}
                  onClick={handlePrevPage}
                  className="h-7 border-zinc-700 text-xs text-mil-muted hover:border-[rgba(232,131,58,0.3)] hover:text-brand-light disabled:opacity-40"
                >
                  ← Previous
                </Button>
                <span className="text-mil-muted">
                  Page {paging?.page || 1} of {paging?.total_pages || 1} · {paging?.total ?? results.length} server{(paging?.total ?? results.length) !== 1 ? 's' : ''}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!paging?.has_next || searching}
                  onClick={handleNextPage}
                  className="h-7 border-zinc-700 text-xs text-mil-muted hover:border-[rgba(232,131,58,0.3)] hover:text-brand-light disabled:opacity-40"
                >
                  Next →
                </Button>
              </div>
            </>
          )}

          {results.length === 0 && !searching && !searchError && (
            <div className="flex flex-col items-center justify-center rounded-lg border border-zinc-800 bg-mil-bg-deep/40 py-12 text-mil-dim">
              <Globe className="mb-3 h-10 w-10" />
              <p className="text-sm">{paging ? 'No servers match that search' : 'Search the public server list by name'}</p>
              <p className="mt-1 px-4 text-center text-xs">
                Free list from{' '}
                <a href={LIST_SITE} target="_blank" rel="noopener noreferrer" className="text-brand hover:underline">reforgermods.net</a>
                {' '}· every public Reforger server, refreshed about once a minute
              </p>
            </div>
          )}
        </div>

        {/* Right — selected server detail */}
        <div className="flex flex-col gap-4">
          {loadingDetail && (
            <div className="flex items-center justify-center rounded-lg border border-zinc-800 bg-mil-bg-deep/40 py-12 text-mil-dim">
              <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Loading server details...
            </div>
          )}

          {detailError && <p className="text-sm text-red-400">{detailError}</p>}

          {selected && !loadingDetail && (
            <>
              {/* Server info */}
              <Card className="border-zinc-800 bg-mil-bg-panel">
                <CardHeader className="pb-3">
                  <CardTitle className="flex items-center gap-2 font-heading text-base text-brand-light">
                    <Server className="h-4 w-4" /> {selected.name}
                  </CardTitle>
                </CardHeader>
                <CardContent className="grid grid-cols-2 gap-3 text-xs sm:grid-cols-3">
                  <div>
                    <span className="block text-mil-dim">Status</span>
                    <Badge variant="outline" className={`capitalize mt-1 text-[11px] ${statusBadge(selected.status)}`}>
                      {selected.status}
                    </Badge>
                  </div>
                  <div>
                    <span className="block text-mil-dim">Players</span>
                    <span className="text-white">{selected.players} / {selected.max_players}</span>
                  </div>
                  <div>
                    <span className="block text-mil-dim">Scenario</span>
                    <span className="text-white">{selected.scenario || '—'}</span>
                  </div>
                  <div>
                    <span className="block text-mil-dim">Region</span>
                    <span className="text-white">{regionLabel(selected.region) || '—'}</span>
                  </div>
                  <div>
                    <span className="block text-mil-dim">Address</span>
                    <span className="font-mono text-white">{selected.host ? `${selected.host}:${selected.port}` : '—'}</span>
                  </div>
                  {selected.direct_join_code && (
                    <div>
                      <span className="block text-mil-dim">Direct join code</span>
                      <span className="font-mono text-white">{selected.direct_join_code}</span>
                    </div>
                  )}
                  {selected.version && (
                    <div>
                      <span className="block text-mil-dim">Version</span>
                      <span className="text-white">{selected.version}</span>
                    </div>
                  )}
                  <div>
                    <span className="block text-mil-dim">Protection</span>
                    <div className="mt-1 flex items-center gap-2">
                      {selected.battleye && (
                        <Badge variant="outline" className="border-green-600/30 text-[11px] text-green-400">
                          <Shield className="mr-1 h-2.5 w-2.5" /> BattlEye
                        </Badge>
                      )}
                      {selected.password && (
                        <Badge variant="outline" className="border-amber-600/30 text-[11px] text-amber-300">
                          <Lock className="mr-1 h-2.5 w-2.5" /> Password
                        </Badge>
                      )}
                      {!selected.battleye && !selected.password && (
                        <span className="text-mil-dim">None</span>
                      )}
                    </div>
                  </div>
                  <div>
                    <span className="block text-mil-dim">Server page</span>
                    <a
                      href={selected.page_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center gap-1 text-brand hover:underline"
                    >
                      View <ExternalLink className="h-3 w-3" />
                    </a>
                  </div>
                </CardContent>
              </Card>

              {/* Mod comparison */}
              <Card className="border-zinc-800 bg-mil-bg-panel">
                <CardHeader className="pb-2">
                  <div className="flex items-center justify-between">
                    <CardTitle className="flex items-center gap-2 font-heading text-sm text-mil-muted">
                      <Package className="h-4 w-4" /> Mods ({selected.mods?.length || 0})
                    </CardTitle>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setShowComparison((v) => !v)}
                      className="h-7 text-xs text-mil-dim"
                    >
                      {showComparison ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                      {showComparison ? 'Hide' : 'Show'} comparison
                    </Button>
                  </div>
                </CardHeader>
                <CardContent>
                  {(!selected.mods || selected.mods.length === 0) ? (
                    <p className="text-xs text-mil-dim">No mod data available for this server.</p>
                  ) : (
                    <div className="space-y-2">
                      {/* Copy all mods button */}
                      {canManage && (
                        <div className="mb-3 flex items-center gap-2">
                          <Button
                            size="sm"
                            disabled={copying}
                            onClick={handleCopyMods}
                            className="h-8 bg-[rgba(232,131,58,0.15)] text-xs text-brand-light hover:bg-[rgba(232,131,58,0.25)]"
                          >
                            {copying ? (
                              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                            ) : copySuccess ? (
                              <CheckCircle className="mr-1.5 h-3.5 w-3.5" />
                            ) : (
                              <Copy className="mr-1.5 h-3.5 w-3.5" />
                            )}
                            {copySuccess ? 'Mods imported!' : 'Copy all mods to this server'}
                          </Button>
                          {copySuccess && (
                            <span className="text-xs text-green-400">
                              Successfully imported {selected.mods.length} mods. Check the Mods tab.
                            </span>
                          )}
                        </div>
                      )}

                      {/* Mod list */}
                      <div className="max-h-72 overflow-y-auto">
                        {selected.mods.map((mod, index) => {
                          const isLocal = mod.mod_id && localModIds.has(mod.mod_id);
                          return (
                            <div
                              key={`${mod.mod_id}-${index}`}
                              className="flex items-center justify-between border-b border-zinc-800/50 py-2 last:border-b-0"
                            >
                              <div className="min-w-0 flex-1">
                                <p className="text-xs leading-snug text-white" style={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{mod.name}</p>
                                <div className="flex items-center gap-2">
                                  {mod.mod_id && (
                                    <a
                                      href={`${WORKSHOP_MOD}${mod.mod_id}`}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      title="Open on the Arma Reforger Workshop"
                                      className="truncate font-mono text-[11px] text-mil-dim hover:text-brand hover:underline"
                                    >
                                      {mod.mod_id}
                                    </a>
                                  )}
                                  {mod.version && (
                                    <Badge variant="outline" className="border-zinc-700 text-[11px] text-mil-dim">
                                      v{mod.version}
                                    </Badge>
                                  )}
                                </div>
                              </div>
                              {showComparison && (
                                <Badge
                                  variant="outline"
                                  className={`ml-2 shrink-0 text-[11px] ${
                                    isLocal
                                      ? 'border-green-600/30 text-green-400'
                                      : 'border-amber-600/30 text-amber-300'
                                  }`}
                                >
                                  {isLocal ? 'Already installed' : 'Not installed'}
                                </Badge>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </CardContent>
              </Card>
            </>
          )}

          {!selected && !loadingDetail && (
            <div className="flex flex-col items-center justify-center rounded-lg border border-zinc-800 bg-mil-bg-deep/40 py-12 text-mil-dim">
              <ArrowRight className="mb-3 h-10 w-10 rotate-180 xl:rotate-0" />
              <p className="text-sm">Select a server from the search results</p>
              <p className="mt-1 text-xs">View mods, configuration, and compare with your server</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default CompareServersModule;
