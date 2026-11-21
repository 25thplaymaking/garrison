import React, { useEffect, useState } from 'react';
import apiClient from '@/lib/apiClient';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  AlertTriangle,
  Calendar,
  CheckCircle,
  Clock,
  Download,
  ExternalLink,
  GitBranch,
  Globe,
  HardDrive,
  Info,
  Loader2,
  Lock,
  LockOpen,
  Map,
  Plus,
  Puzzle,
  Star,
  Tag,
  Users,
} from 'lucide-react';
function humanSize(bytes) {
  if (!bytes || bytes <= 0) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let n = bytes;
  for (const unit of units) {
    if (n < 1024) return `${n.toFixed(unit === 'B' ? 0 : 1)} ${unit}`;
    n /= 1024;
  }
  return `${n.toFixed(1)} TB`;
}

function formatDate(dateStr) {
  if (!dateStr) return '—';
  try {
    const d = new Date(dateStr);
    return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
  } catch {
    return dateStr;
  }
}

function formatRating(rating) {
  if (rating === null || rating === undefined || rating === 0) return '—';
  // Handle string format from browse results like "89%"
  if (typeof rating === 'string') {
    if (rating.endsWith('%')) return rating;
    const parsed = parseFloat(rating);
    if (Number.isNaN(parsed)) return '—';
    return parsed <= 1 ? `${Math.round(parsed * 100)}%` : `${Math.round(parsed)}%`;
  }
  const num = Number(rating);
  if (Number.isNaN(num)) return '—';
  const pct = num <= 1 ? num * 100 : num;
  return `${Math.round(pct)}%`;
}

function StatBox({ icon: Icon, label, value }) {
  return (
    <div className="flex flex-col items-center rounded-lg border border-zinc-800 bg-mil-bg-deep/40 px-3 py-2">
      <Icon className="mb-1 h-3.5 w-3.5 text-mil-dim" />
      <span className="text-sm font-medium text-mil-fg">{value != null && value !== '' ? value : '—'}</span>
      <span className="text-[11px] text-mil-dim">{label}</span>
    </div>
  );
}

function InfoRow({ label, value, mono }) {
  return (
    <div className="flex items-center justify-between border-b border-zinc-800/50 py-1.5">
      <span className="text-[11px] font-medium text-mil-dim">{label}</span>
      <span className={`text-sm text-mil-fg ${mono ? 'font-mono text-xs' : ''}`}>{value != null && value !== '' ? value : '—'}</span>
    </div>
  );
}

// ─── Overview Tab ────────────────────────────────────────────────────────────
function OverviewTab({ mod }) {
  return (
    <div className="space-y-4">
      {mod.thumbnail_url && (
        <img src={mod.thumbnail_url} alt="" className="h-36 w-full rounded-lg object-cover" />
      )}

      {/* Stats row */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <StatBox icon={Star} label="Rating" value={formatRating(mod.rating)} />
        <StatBox icon={Users} label="Subscribers" value={mod.subscribers?.toLocaleString()} />
        <StatBox icon={Download} label="Downloads" value={mod.downloads?.toLocaleString()} />
        <StatBox icon={HardDrive} label="Size" value={humanSize(mod.current_version_size)} />
      </div>

      {/* Summary */}
      {mod.summary && mod.summary !== mod.description && (
        <p className="text-sm italic text-mil-muted">{mod.summary}</p>
      )}

      {/* Description */}
      {mod.description && (
        <div>
          <div className="text-xs font-medium text-mil-dim">Description</div>
          <p className="mt-1 max-h-32 overflow-y-auto whitespace-pre-line text-sm text-mil-muted">{mod.description}</p>
        </div>
      )}

      {/* Info grid */}
      <div className="rounded-lg border border-zinc-800 bg-mil-bg-deep/40 p-3">
        <InfoRow label="Mod ID" value={mod.mod_id} mono />
        <InfoRow label="Author" value={mod.author} />
        <InfoRow label="Version" value={mod.version} />
        <InfoRow label="Game Version" value={mod.game_version} />
        <InfoRow label="License" value={mod.license} />
        <InfoRow label="Created" value={formatDate(mod.created_at)} />
        <InfoRow label="Last Modified" value={formatDate(mod.updated_at)} />
      </div>

      {/* Tags */}
      {!!mod.tags?.length && (
        <div className="flex flex-wrap gap-1.5">
          {mod.tags.map((tag) => (
            <Badge key={tag} variant="outline" className="border-zinc-700 text-[11px] text-mil-muted">
              <Tag className="mr-1 h-2.5 w-2.5" /> {tag}
            </Badge>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Dependencies Tab ────────────────────────────────────────────────────────
function DependenciesTab({ mod, enabledModIds, onAddDependency, onResolveAll }) {
  const deps = mod.dependencies || [];
  if (!deps.length) {
    return <p className="py-6 text-center text-sm text-mil-dim">This mod has no dependencies.</p>;
  }

  const getDependencyId = (dep) => dep.mod_id || dep.modId || '';
  const missingDeps = deps.filter((d) => {
    const depId = getDependencyId(d);
    return depId && !enabledModIds.has(depId);
  });

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm text-mil-muted">
          {deps.length} dependenc{deps.length === 1 ? 'y' : 'ies'}
          {missingDeps.length > 0 && (
            <span className="ml-1 text-amber-300">({missingDeps.length} not in config)</span>
          )}
        </p>
        {onResolveAll && (
          <Button size="sm" variant="outline" onClick={onResolveAll} className="border-zinc-700 text-mil-muted hover:bg-zinc-900 hover:text-white">
            <GitBranch className="mr-1 h-3 w-3" /> {missingDeps.length > 0 ? 'Add All Dependencies' : 'Check Full Tree'}
          </Button>
        )}
      </div>
      <p className="text-[11px] text-mil-dim">
        Recursive resolution checks the full dependency tree, not just the direct entries listed below.
      </p>

      <div className="space-y-1.5 rounded-lg border border-zinc-800 bg-mil-bg-deep/40 p-3">
        {deps.map((dep, idx) => {
          const depId = getDependencyId(dep);
          const isPresent = depId && enabledModIds.has(depId);
          return (
            <div key={depId || idx} className="flex items-center gap-2 rounded-lg px-2 py-1.5">
              <span className="min-w-0 flex-1">
                {dep.name && dep.name !== depId ? (
                  <>
                    <span className="text-sm text-mil-fg">{dep.name}</span>
                    <span className="ml-2 font-mono text-[11px] text-mil-dim">{depId}</span>
                  </>
                ) : (
                  <span className="font-mono text-xs text-mil-fg">{depId}</span>
                )}
                {dep.version && <span className="ml-2 text-[11px] text-mil-dim">v{dep.version}</span>}
              </span>
              {isPresent ? (
                <Badge variant="outline" className="border-emerald-600/30 text-[11px] text-emerald-300">
                  <CheckCircle className="mr-0.5 h-2.5 w-2.5" /> In config
                </Badge>
              ) : (
                <div className="flex items-center gap-1">
                  <Badge variant="outline" className="border-amber-500/30 text-[11px] text-amber-300">
                    <AlertTriangle className="mr-0.5 h-2.5 w-2.5" /> Missing
                  </Badge>
                  {onAddDependency && (
                    <Button aria-label="Add"
                      size="sm"
                      variant="ghost"
                      onClick={() => onAddDependency({ ...dep, mod_id: depId, modId: depId })}
                      className="h-6 px-1.5 text-[11px] text-blue-300 hover:text-white"
                    >
                      <Plus className="h-3 w-3" />
                    </Button>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Versions Tab ────────────────────────────────────────────────────────────
function VersionsTab({ mod, pinnedVersion, onPinVersion }) {
  const versions = mod.versions || [];
  if (!versions.length) {
    return <p className="py-6 text-center text-sm text-mil-dim">No version history available.</p>;
  }

  const isPinned = pinnedVersion && pinnedVersion !== '';

  return (
    <div className="space-y-3">
      {mod.changelog && (
        <div className="rounded-lg border border-zinc-800 bg-mil-bg-deep/40 p-3">
          <div className="mb-1 text-xs font-medium text-mil-dim">Latest Changelog</div>
          <p className="max-h-24 overflow-y-auto whitespace-pre-line text-sm text-mil-muted">
            {mod.changelog || 'No changelog provided for this version.'}
          </p>
        </div>
      )}

      {isPinned && onPinVersion && (
        <div className="flex items-center gap-2 rounded-lg border border-blue-500/20 bg-blue-500/5 px-3 py-2">
          <Lock className="h-3 w-3 shrink-0 text-blue-400" />
          <span className="min-w-0 flex-1 text-xs text-blue-300">
            Pinned to <span className="font-mono font-medium">v{pinnedVersion}</span>. This exact version will be written to the server config.
          </span>
          <button
            type="button"
            onClick={() => onPinVersion(mod.mod_id || mod.modId, '')}
            className="shrink-0 rounded border border-blue-500/30 px-2 py-0.5 text-[11px] text-blue-300 hover:bg-blue-500/10 hover:text-blue-200"
          >
            <LockOpen className="mr-1 inline h-2.5 w-2.5" />Clear pin
          </button>
        </div>
      )}

      <div className="max-h-72 space-y-1.5 overflow-y-auto rounded-lg border border-zinc-800 bg-mil-bg-deep/40 p-3">
        {versions.map((v, idx) => {
          const isCurrent = v.version === mod.version;
          const isThisPinned = isPinned && v.version === pinnedVersion;
          return (
            <div
              key={v.version || idx}
              className={`flex flex-col gap-1 rounded-lg px-2 py-2 sm:flex-row sm:items-center sm:gap-3 ${
                isThisPinned
                  ? 'border border-blue-500/25 bg-blue-500/5'
                  : isCurrent
                  ? 'border border-brand/20 bg-brand/5'
                  : 'border border-transparent'
              }`}
            >
              {/* Version label + badges */}
              <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
                <span className={`text-sm font-medium ${
                  isThisPinned ? 'text-blue-300' : isCurrent ? 'text-brand' : 'text-mil-fg'
                }`}>
                  v{v.version}
                </span>
                {isCurrent && (
                  <Badge variant="outline" className="border-brand/30 text-[11px] text-brand">Latest</Badge>
                )}
                {isThisPinned && (
                  <Badge variant="outline" className="border-blue-500/30 text-[11px] text-blue-300">
                    <Lock className="mr-0.5 h-2 w-2" />Pinned
                  </Badge>
                )}
              </div>

              {/* Metadata row */}
              <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-mil-dim">
                {v.game_version && (
                  <span className="flex items-center gap-0.5">
                    <Globe className="h-2.5 w-2.5" /> {v.game_version}
                  </span>
                )}
                {v.file_size > 0 && (
                  <span className="flex items-center gap-0.5">
                    <HardDrive className="h-2.5 w-2.5" /> {humanSize(v.file_size)}
                  </span>
                )}
                {v.created_at && (
                  <span className="flex items-center gap-0.5">
                    <Calendar className="h-2.5 w-2.5" /> {formatDate(v.created_at)}
                  </span>
                )}
              </div>

              {/* Pin button */}
              {onPinVersion && (
                <button
                  type="button"
                  disabled={isThisPinned}
                  onClick={() => onPinVersion(mod.mod_id || mod.modId, v.version)}
                  className={`shrink-0 self-end rounded border px-2 py-0.5 text-[11px] transition-colors sm:self-auto ${
                    isThisPinned
                      ? 'cursor-default border-blue-500/30 text-blue-400'
                      : 'border-zinc-700 text-mil-dim hover:border-zinc-500 hover:text-mil-fg'
                  }`}
                >
                  {isThisPinned ? (
                    <><Lock className="mr-0.5 inline h-2.5 w-2.5" />Pinned</>
                  ) : (
                    <><Lock className="mr-0.5 inline h-2.5 w-2.5" />Pin version</>
                  )}
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Scenarios Tab ───────────────────────────────────────────────────────────
function ScenariosTab({
  mod,
  activeScenarioId,
  sharedScenarioIds = new Set(),
  canActivateScenario = true,
  onAddScenarioToLibrary,
  onAddScenarioToJson,
}) {
  const scenarios = mod.scenarios || [];
  const [pendingAction, setPendingAction] = useState(null);

  if (!scenarios.length) {
    return <p className="py-6 text-center text-sm text-mil-dim">This mod has no scenarios.</p>;
  }

  const handleScenarioAction = async (action, scenarioId) => {
    if (!action || !scenarioId) return;
    setPendingAction(`${action}:${scenarioId}`);
    try {
      if (action === 'library') {
        const scenario = scenarios.find((item) => item.scenario_id === scenarioId);
        await onAddScenarioToLibrary?.(scenario);
      } else if (action === 'json') {
        await onAddScenarioToJson?.(scenarioId);
      }
    } catch {
      // Parent callbacks handle user-facing error feedback.
    } finally {
      setPendingAction(null);
    }
  };

  return (
    <div className="space-y-3">
      {!canActivateScenario && (
        <div className="rounded-lg border border-amber-600/20 bg-amber-950/20 px-3 py-2 text-[11px] text-amber-300">
          Add the mod to the load order and save it before pushing one of its scenarios into the active mission JSON.
        </div>
      )}
      {scenarios.map((sc, idx) => {
        const scenarioId = sc.scenario_id || '';
        const isActive = activeScenarioId === scenarioId;
        const isShared = sharedScenarioIds.has(scenarioId);
        const libraryBusy = pendingAction === `library:${scenarioId}`;
        const jsonBusy = pendingAction === `json:${scenarioId}`;
        return (
          <div key={scenarioId || idx} className="overflow-hidden rounded-lg border border-zinc-800 bg-mil-bg-deep/40">
            {sc.thumbnail_url && (
              <img src={sc.thumbnail_url} alt="" className="h-28 w-full object-cover" />
            )}
            <div className="p-3 space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h4 className="text-sm font-medium text-mil-fg">{sc.name || 'Unnamed Scenario'}</h4>
                <div className="flex flex-wrap items-center gap-1">
                  {isShared && (
                    <Badge variant="outline" className="border-amber-500/30 text-[11px] text-amber-300">Shared</Badge>
                  )}
                  {isActive && (
                    <Badge variant="outline" className="border-emerald-600/30 text-[11px] text-emerald-300">Active</Badge>
                  )}
                </div>
              </div>

              <div className="flex flex-wrap gap-2 text-[11px] text-mil-dim">
                {sc.game_mode && (
                  <span className="flex items-center gap-0.5">
                    <Puzzle className="h-2.5 w-2.5" /> {sc.game_mode}
                  </span>
                )}
                {sc.player_count > 0 && (
                  <span className="flex items-center gap-0.5">
                    <Users className="h-2.5 w-2.5" /> {sc.player_count} players
                  </span>
                )}
              </div>

              {sc.description && (
                <p className="max-h-16 overflow-y-auto text-xs text-mil-muted">{sc.description}</p>
              )}

              <code className="block overflow-hidden rounded bg-zinc-900 px-2 py-1 font-mono text-[11px] text-mil-dim">
                <span className="block truncate">{scenarioId}</span>
              </code>

              <div className="flex flex-col gap-2 sm:flex-row">
                {onAddScenarioToLibrary && (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={isShared || libraryBusy || !scenarioId}
                    onClick={() => handleScenarioAction('library', scenarioId)}
                    className={`w-full sm:flex-1 ${
                      isShared
                        ? 'border-amber-500/30 text-amber-300'
                        : 'border-zinc-700 text-mil-fg hover:bg-zinc-900 hover:text-white'
                    }`}
                  >
                    {libraryBusy ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <Star className="mr-1 h-3 w-3" />}
                    {isShared ? 'In Scenarios List' : 'Add to Scenarios List'}
                  </Button>
                )}
                {onAddScenarioToJson && (
                  <Button
                    size="sm"
                    variant={isActive ? 'outline' : 'default'}
                    disabled={isActive || jsonBusy || !canActivateScenario || !scenarioId}
                    onClick={() => handleScenarioAction('json', scenarioId)}
                    className={isActive
                      ? 'w-full border-emerald-600/30 text-emerald-300 sm:flex-1'
                      : 'w-full bg-brand text-black hover:bg-brand-light sm:flex-1'
                    }
                  >
                    {jsonBusy ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <Map className="mr-1 h-3 w-3" />}
                    {isActive ? 'Active in JSON' : 'Add to JSON'}
                  </Button>
                )}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ─── Main Component ──────────────────────────────────────────────────────────
export default function ModDetailPanel({
  open,
  onOpenChange,
  mod,
  serverId,
  enabledModIds = new Set(),
  savedEnabledModIds = new Set(),
  activeScenarioId = '',
  sharedScenarioIds = new Set(),
  pinnedVersion = '',
  onAddMod,
  onAddDependency,
  onResolveAll,
  onAddScenarioToLibrary,
  onAddScenarioToJson,
  onPinVersion,
}) {
  const [enrichedMod, setEnrichedMod] = useState(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');

  useEffect(() => {
    if (!open || !mod) {
      setEnrichedMod(null);
      return;
    }
    setEnrichedMod(mod);

    const modId = mod.mod_id || mod.modId;
    if (!modId) return;

    let cancelled = false;
    setLoading(true);
    setLoadError('');
    apiClient.get(`/servers/workshop/mod/${modId}/details`)
      .then((res) => {
        if (!cancelled) {
          setEnrichedMod((prev) => ({ ...prev, ...res.data }));
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setLoadError(error.response?.data?.detail || 'Workshop details could not be loaded; showing what is cached.');
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  }, [open, mod]);

  const displayMod = enrichedMod || mod;
  if (!displayMod) return null;

  const hasScenarios = !!(displayMod.scenarios?.length);
  const hasVersions = !!(displayMod.versions?.length);
  const hasDeps = !!(displayMod.dependencies?.length);
  const depCount = displayMod.dependencies?.length || 0;
  const scenarioCount = displayMod.scenarios?.length || 0;
  const versionCount = displayMod.versions?.length || 0;
  const displayModId = displayMod.mod_id || displayMod.modId || '';
  const canActivateScenario = !displayModId || savedEnabledModIds.has(displayModId);
  const removedFromWorkshop = displayMod.removed_from_workshop === true
    || displayMod.availability_status === 'removed';
  const blockedFlags = Object.entries(displayMod.workshop_flags || {})
    .filter(([flag, value]) => value && (flag === 'blocked' || flag === 'private'))
    .map(([flag]) => flag);
  const unavailableDeps = (displayMod.dependencies || []).filter((dep) => dep.unavailable?.length);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[calc(100vw-2rem)] max-w-xl border-zinc-800 bg-zinc-950 text-white sm:w-full">
        <DialogHeader>
          <DialogTitle className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-brand">
            <Puzzle className="h-5 w-5 shrink-0" />
            <span className="min-w-0 truncate">{displayMod.name || displayMod.mod_id || 'Mod Details'}</span>
            {displayMod.author && (
              <span className="ml-1 text-sm font-normal text-mil-dim">by {displayMod.author}</span>
            )}
            {loading && <Loader2 className="ml-auto h-4 w-4 animate-spin text-mil-dim" />}
          </DialogTitle>
        </DialogHeader>

        {removedFromWorkshop && (
          <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-200" role="alert">
            <div className="flex items-center gap-2 font-medium">
              <AlertTriangle className="h-4 w-4 shrink-0" /> Removed from Workshop
            </div>
            <p className="mt-1 text-red-200/80">
              This entry is preserved for diagnosis and existing loadout review, but it can no longer be added as an available Workshop mod.
            </p>
          </div>
        )}

        {!removedFromWorkshop && (blockedFlags.length > 0 || unavailableDeps.length > 0) && (
          <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-200" role="alert">
            <div className="flex items-center gap-2 font-medium">
              <AlertTriangle className="h-4 w-4 shrink-0" /> A server cannot download this mod as published
            </div>
            <p className="mt-1 text-red-200/80">
              {blockedFlags.length > 0 ? `The mod is ${blockedFlags.join(' and ')} on the Workshop. ` : ''}
              {unavailableDeps.length > 0
                ? `Unavailable dependencies: ${unavailableDeps.map((dep) => `${dep.name || dep.mod_id} (${dep.unavailable.join('/')})`).join(', ')}.`
                : ''}
            </p>
          </div>
        )}

        {loadError && (
          <p className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">{loadError}</p>
        )}

        <Tabs defaultValue="overview" className="mt-1">
          <TabsList className="grid w-full grid-cols-4 bg-zinc-900">
            <TabsTrigger value="overview" className="text-[11px] data-[state=active]:bg-zinc-800 data-[state=active]:text-brand sm:text-xs">
              <Info className="mr-1 h-3 w-3 shrink-0" /><span className="hidden xs:inline">Overview</span><span className="xs:hidden">Info</span>
            </TabsTrigger>
            <TabsTrigger value="dependencies" className="text-[11px] data-[state=active]:bg-zinc-800 data-[state=active]:text-brand sm:text-xs">
              <GitBranch className="mr-1 h-3 w-3 shrink-0" /><span className="hidden xs:inline">Deps</span>{depCount > 0 ? ` (${depCount})` : ''}
            </TabsTrigger>
            <TabsTrigger value="versions" className="text-[11px] data-[state=active]:bg-zinc-800 data-[state=active]:text-brand sm:text-xs">
              <Clock className="mr-1 h-3 w-3 shrink-0" /><span className="hidden xs:inline">Versions</span>{versionCount > 0 ? ` (${versionCount})` : ''}
            </TabsTrigger>
            <TabsTrigger value="scenarios" className="text-[11px] data-[state=active]:bg-zinc-800 data-[state=active]:text-brand sm:text-xs">
              <Map className="mr-1 h-3 w-3 shrink-0" /><span className="hidden xs:inline">Scenarios</span>{scenarioCount > 0 ? ` (${scenarioCount})` : ''}
            </TabsTrigger>
          </TabsList>

          <div className="mt-3 max-h-[60vh] overflow-y-auto pr-1">
            <TabsContent value="overview" className="mt-0">
              <OverviewTab mod={displayMod} />
            </TabsContent>

            <TabsContent value="dependencies" className="mt-0">
              <DependenciesTab
                mod={displayMod}
                enabledModIds={enabledModIds}
                onAddDependency={onAddDependency}
                onResolveAll={onResolveAll}
              />
            </TabsContent>

            <TabsContent value="versions" className="mt-0">
              <VersionsTab
                mod={displayMod}
                pinnedVersion={pinnedVersion}
                onPinVersion={onPinVersion}
              />
            </TabsContent>

            <TabsContent value="scenarios" className="mt-0">
              <ScenariosTab
                mod={displayMod}
                activeScenarioId={activeScenarioId}
                sharedScenarioIds={sharedScenarioIds}
                canActivateScenario={canActivateScenario}
                onAddScenarioToLibrary={onAddScenarioToLibrary}
                onAddScenarioToJson={onAddScenarioToJson}
              />
            </TabsContent>
          </div>
        </Tabs>

        {/* Action buttons */}
        <div className="mt-2 flex flex-wrap gap-2 border-t border-zinc-800 pt-3">
          {onAddMod && (
            <Button
              size="sm"
              onClick={() => onAddMod(displayMod)}
              disabled={removedFromWorkshop}
              className="bg-brand text-black hover:bg-brand-light"
            >
              <Plus className="mr-1 h-3.5 w-3.5" /> Add to load order
            </Button>
          )}
          {hasDeps && onResolveAll && (
            <Button size="sm" variant="outline" onClick={onResolveAll} className="border-zinc-700 text-mil-muted hover:bg-zinc-900 hover:text-white">
              <GitBranch className="mr-1 h-3.5 w-3.5" /> Resolve Dependencies
            </Button>
          )}
          {displayMod.workshop_url && (
            <a href={displayMod.workshop_url} target="_blank" rel="noopener noreferrer">
              <Button size="sm" variant="ghost" className="text-mil-dim hover:text-white">
                <ExternalLink className="mr-1 h-3.5 w-3.5" /> Workshop
              </Button>
            </a>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
