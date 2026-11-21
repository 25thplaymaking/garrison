import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useOutletContext } from 'react-router';
import apiClient from '@/lib/apiClient';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Bookmark,
  CheckCircle,
  Copy,
  Download,
  FileJson,
  FileUp,
  GitBranch,
  History,
  Loader2,
  Lock,
  Map,
  Package,
  Plus,
  GripVertical,
  Puzzle,
  RefreshCw,
  Save,
  Search,
  Server,
  Shield,
  Trash2,
  Upload,
} from 'lucide-react';
import ModDetailPanel from '@/components/ModDetailPanel';
import ModRevisionHistory from './history/ModRevisionHistory';
import MirrorPullPanel from './MirrorPullPanel';
import { toast } from '@/hooks/use-toast';
import { useUnsavedChanges } from '@/context/UnsavedChangesContext';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import useConfirmDialog from '@/hooks/useConfirmDialog';
import { CommandEmptyState, CommandLoadingState } from '@/components/tactical/CommandUI';
import { filterLoadOrder, isFilterActive } from './modsFilters';
import { formatApiError } from '@/utils/errorMessages';


const WORKSHOP_CATEGORY_MAP = {
  popularity: 'popular',
  newest: 'newest',
  subscribers: 'subscribers',
  versionSize: 'versionSize',
};

function normalizeModEntry(mod) {
  const modId = mod.mod_id || mod.modId || '';
  return {
    ...mod,
    mod_id: modId,
    modId: modId,
    name: mod.name || modId,
    enabled: mod.enabled !== false,
  };
}

function isRemovedWorkshopMod(mod) {
  return mod?.removed_from_workshop === true || mod?.availability_status === 'removed';
}

function parseImportPayload(raw) {
  const parsed = JSON.parse(raw);
  if (Array.isArray(parsed)) return parsed;
  if (Array.isArray(parsed?.mods)) return parsed.mods;
  // Support full Reforger server config.json — mods live at game.mods
  if (Array.isArray(parsed?.game?.mods)) {
    return parsed.game.mods.map((m) => ({
      mod_id: m.modId || m.mod_id || '',
      name: m.name || m.modId || m.mod_id || '',
      version: m.version || '',
      enabled: true,
    }));
  }
  return [];
}

function toModPayload(mod) {
  return {
    mod_id: mod.mod_id,
    modId: mod.mod_id,
    name: mod.name,
    enabled: mod.enabled,
    version: mod.version,
    author: mod.author,
    description: mod.description,
    tags: mod.tags,
    dependencies: mod.dependencies,
    scenario_ids: mod.scenario_ids,
    thumbnail_url: mod.thumbnail_url,
    metadata_source: mod.metadata_source,
    system_managed: mod.system_managed === true,
    dependency_of: mod.dependency_of,
  };
}

function DepTreeNode({ node, depth = 0 }) {
  const hasChildren = node.children?.length > 0;
  return (
    <div className={depth > 0 ? 'ml-3 border-l border-zinc-800 pl-3' : ''}>
      <div className="flex items-center gap-2 py-1">
        {node.thumbnail_url ? (
          <img src={node.thumbnail_url} alt="" loading="lazy" className="h-6 w-6 shrink-0 rounded border border-zinc-800 object-cover" />
        ) : (
          <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded border border-zinc-800 bg-zinc-900">
            <Puzzle className="h-3 w-3 text-mil-dim" />
          </div>
        )}
        <span className="min-w-0 truncate text-xs text-mil-fg">{node.name}</span>
        {node.already_present ? (
          <Badge variant="outline" className="shrink-0 border-emerald-600/30 text-[11px] text-emerald-300">In loadout</Badge>
        ) : (
          <Badge variant="outline" className="shrink-0 border-blue-600/30 text-[11px] text-blue-300">Will add</Badge>
        )}
        {node.cycle && <Badge variant="outline" className="shrink-0 border-amber-600/30 text-[11px] text-amber-300">cycle</Badge>}
      </div>
      {hasChildren && node.children.map((child, i) => (
        <DepTreeNode key={`${child.mod_id}-${i}`} node={child} depth={depth + 1} />
      ))}
    </div>
  );
}

function ModsModule() {
  const { server, serverId, fetchServer, canManage, user, bumpScenarioRefresh } = useOutletContext();
  const { registerDirtySource } = useUnsavedChanges();
  const { confirm, dialog: confirmDialog } = useConfirmDialog();
  const [activeTab, setActiveTab] = useState('workshop');
  const [enabledMods, setEnabledMods] = useState([]);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [validating, setValidating] = useState(false);
  const [validationIssues, setValidationIssues] = useState([]);

  const [workshopMods, setWorkshopMods] = useState([]);
  const [workshopSearch, setWorkshopSearch] = useState('');
  const debouncedWorkshopSearch = useDebouncedValue(workshopSearch, 450);
  const [workshopQuery, setWorkshopQuery] = useState('');
  const [workshopSort, setWorkshopSort] = useState('popularity');
  const [workshopTags, setWorkshopTags] = useState('');
  const debouncedWorkshopTags = useDebouncedValue(workshopTags, 450);
  const [workshopTagQuery, setWorkshopTagQuery] = useState('');
  const [workshopLoading, setWorkshopLoading] = useState(false);
  const [workshopPage, setWorkshopPage] = useState(1);
  const [workshopTotalPages, setWorkshopTotalPages] = useState(1);
  const [workshopSource, setWorkshopSource] = useState('live');
  const [workshopError, setWorkshopError] = useState('');
  const [workshopRefreshKey, setWorkshopRefreshKey] = useState(0);
  const workshopRequestIdRef = useRef(0);

  const [downloadHistory, setDownloadHistory] = useState([]);
  const [historyLoading, setHistoryLoading] = useState(false);

  const [detailOpen, setDetailOpen] = useState(false);
  const [selectedMod, setSelectedMod] = useState(null);
  const [sharedScenarios, setSharedScenarios] = useState([]);

  const [importPayload, setImportPayload] = useState('');
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState('');
  const [exportPayload, setExportPayload] = useState('');
  const [exporting, setExporting] = useState(false);
  const [exportMode, setExportMode] = useState('mods'); // 'mods' | 'config'
  const [manualMod, setManualMod] = useState({ mod_id: '', name: '', version: '' });
  const [manualModError, setManualModError] = useState('');
  const fileInputRef = React.useRef(null);

  const [managedServers, setManagedServers] = useState([]);
  // Pull is the default: changes are usually made from the server being changed.
  const [mirrorDirection, setMirrorDirection] = useState('pull');
  const [mirrorLoadingServers, setMirrorLoadingServers] = useState(false);
  const [mirrorSelectedTargets, setMirrorSelectedTargets] = useState([]);
  const [mirrorOptions, setMirrorOptions] = useState({
    preserve_system_managed: true,
    include_disabled: true,
    include_pinned_versions: true,
    create_backups: true,
    restart_mode: 'none',
  });
  const [mirrorConfirmOpen, setMirrorConfirmOpen] = useState(false);
  const [mirrorRunning, setMirrorRunning] = useState(false);
  const [mirrorError, setMirrorError] = useState('');
  const [mirrorResults, setMirrorResults] = useState([]);

  // Mod Presets state
  const [presets, setPresets] = useState([]);
  const [presetsLoading, setPresetsLoading] = useState(false);
  const [presetsError, setPresetsError] = useState('');
  const [savePresetOpen, setSavePresetOpen] = useState(false);
  const [newPresetName, setNewPresetName] = useState('');
  const [savingPreset, setSavingPreset] = useState(false);
  const [deletingPresetId, setDeletingPresetId] = useState(null);
  const [applyingPresetId, setApplyingPresetId] = useState(null);

  // Dependency resolution state
  const [depDialogOpen, setDepDialogOpen] = useState(false);
  const [depResolved, setDepResolved] = useState(null);
  const [depLoading, setDepLoading] = useState(false);
  const [depSourceMod, setDepSourceMod] = useState(null);

  // Loadout-wide dependency resolution state
  const [resolveAllOpen, setResolveAllOpen] = useState(false);
  const [resolveAllLoading, setResolveAllLoading] = useState(false);
  const [resolveAllData, setResolveAllData] = useState(null);
  const [resolveAllTab, setResolveAllTab] = useState('additions');

  // Revision history state
  const [historyOpen, setHistoryOpen] = useState(false);
  const [draggedModIndex, setDraggedModIndex] = useState(null);
  const [dropTargetIndex, setDropTargetIndex] = useState(null);
  // Load Order search. Entries keep their absolute index so reordering while
  // filtered still moves the right mod — see modsFilters.js.
  const [loadOrderSearch, setLoadOrderSearch] = useState('');
  const visibleLoadOrder = useMemo(
    () => filterLoadOrder(enabledMods, loadOrderSearch),
    [enabledMods, loadOrderSearch],
  );
  const loadOrderFiltered = isFilterActive(loadOrderSearch);
  const [editingOrderIndex, setEditingOrderIndex] = useState(null);
  const [orderInputValue, setOrderInputValue] = useState('');
  const systemManagedMods = useMemo(
    () => (server?.mods || []).map(normalizeModEntry).filter((mod) => mod.system_managed),
    [server?.mods],
  );

  useEffect(() => {
    if (!dirty) {
      setEnabledMods((server?.mods || []).map(normalizeModEntry).filter((mod) => !mod.system_managed));
    }
  }, [server?.mods, dirty]);

  const fetchDownloadHistory = useCallback(async () => {
    setHistoryLoading(true);
    try {
      const res = await apiClient.get('/servers/mod-download-history');
      setDownloadHistory(res.data || []);
    } catch {
      setDownloadHistory([]);
    } finally {
      setHistoryLoading(false);
    }
  }, []);

  const fetchSharedScenarios = useCallback(async () => {
    try {
      const res = await apiClient.get(`/servers/${serverId}/scenarios`);
      setSharedScenarios(res.data?.shared || []);
    } catch {
      setSharedScenarios([]);
    }
  }, [serverId]);

  const fetchManagedServers = useCallback(async () => {
    setMirrorLoadingServers(true);
    try {
      const res = await apiClient.get('/servers');
      const servers = Array.isArray(res.data) ? res.data : (res.data?.servers || []);
      setManagedServers(servers);
    } catch {
      setManagedServers([]);
    } finally {
      setMirrorLoadingServers(false);
    }
  }, []);

  useEffect(() => {
    setWorkshopPage(1);
    setWorkshopQuery(debouncedWorkshopSearch);
  }, [debouncedWorkshopSearch]);

  useEffect(() => {
    setWorkshopPage(1);
    setWorkshopTagQuery(debouncedWorkshopTags.trim());
  }, [debouncedWorkshopTags]);

  const submitWorkshopSearch = useCallback(() => {
    const nextQuery = workshopSearch.trim();
    const nextTags = workshopTags.trim();
    setWorkshopPage(1);
    if (nextQuery === workshopQuery && nextTags === workshopTagQuery) {
      setWorkshopRefreshKey((value) => value + 1);
    } else {
      setWorkshopQuery(nextQuery);
      setWorkshopTagQuery(nextTags);
    }
  }, [workshopQuery, workshopSearch, workshopTagQuery, workshopTags]);

  const searchWorkshop = useCallback(async () => {
    const requestId = ++workshopRequestIdRef.current;
    const query = workshopQuery.trim();
    setWorkshopLoading(true);
    setWorkshopError('');
    let cachedMods = [];
    let cachedTotalPages = 1;
    try {
      const params = {
        page: workshopPage,
        sort: workshopSort,
      };
      if (workshopTagQuery) params.tags = workshopTagQuery;

      if (query && !workshopTagQuery) {
        try {
          const cachedResponse = await apiClient.get('/servers/workshop/search', {
            params: { q: query, page: workshopPage, per_page: 16 },
          });
          if (requestId !== workshopRequestIdRef.current) return;
          cachedMods = cachedResponse.data?.mods || [];
          cachedTotalPages = Math.max(1, Math.ceil((cachedResponse.data?.total || cachedMods.length) / 16));
          if (cachedMods.length > 0) {
            setWorkshopMods(cachedMods);
            setWorkshopTotalPages(cachedTotalPages);
            setWorkshopSource('cache');
          }
        } catch {
          // The live Workshop lookup below remains authoritative.
        }
      }

      const response = query
        ? await apiClient.get('/workshop/search', { params: { ...params, q: query } })
        : await apiClient.get('/workshop/browse', {
            params: {
              category: WORKSHOP_CATEGORY_MAP[workshopSort] || 'popular',
              page: workshopPage,
              tags: workshopTagQuery || undefined,
            },
          });
      if (requestId !== workshopRequestIdRef.current) return;
      const liveMods = response.data?.mods || [];
      const useCached = liveMods.length === 0 && cachedMods.length > 0;
      setWorkshopMods(useCached ? cachedMods : liveMods);
      setWorkshopTotalPages(useCached
        ? cachedTotalPages
        : (response.data?.total_pages || 1));
      setWorkshopSource(useCached ? 'cache' : (response.data?.source || 'live'));
      const responseError = response.data?.error || '';
      setWorkshopError(responseError && useCached ? `${responseError}. Showing indexed results.` : responseError);
    } catch (error) {
      if (requestId !== workshopRequestIdRef.current) return;
      if (cachedMods.length === 0) {
        setWorkshopMods([]);
        setWorkshopTotalPages(1);
      }
      setWorkshopSource(cachedMods.length > 0 ? 'cache' : 'error');
      setWorkshopError(cachedMods.length > 0
        ? 'Live Workshop search is unavailable. Showing indexed results.'
        : (formatApiError(error, 'Workshop search is temporarily unavailable.')));
    } finally {
      if (requestId === workshopRequestIdRef.current) setWorkshopLoading(false);
    }
  }, [workshopPage, workshopQuery, workshopRefreshKey, workshopSort, workshopTagQuery]);

  useEffect(() => {
    searchWorkshop();
  }, [searchWorkshop]);

  useEffect(() => {
    fetchDownloadHistory();
  }, [fetchDownloadHistory]);

  useEffect(() => {
    fetchSharedScenarios();
  }, [fetchSharedScenarios]);

  useEffect(() => {
    // Mirror needs a fresh list; the Workshop tab's download history only needs
    // names once, so it can label entries by server instead of by raw ID.
    if (activeTab === 'mirror' || (activeTab === 'workshop' && managedServers.length === 0)) {
      fetchManagedServers();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- refetch on tab change only
  }, [activeTab, fetchManagedServers]);

  const serverNameById = useMemo(
    () => Object.fromEntries(managedServers.map((item) => [item.id, item.name])),
    [managedServers],
  );

  const fetchPresets = useCallback(async () => {
    setPresetsLoading(true);
    try {
      const res = await apiClient.get('/servers/presets');
      const list = Array.isArray(res.data) ? res.data : (res.data?.presets || []);
      setPresets(list);
      setPresetsError('');
    } catch (error) {
      const detail = error.response?.data?.detail;
      setPresetsError((typeof detail === 'string' ? detail : detail?.message) || 'Failed to load mod presets.');
      setPresets([]);
    } finally {
      setPresetsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (activeTab === 'presets') {
      fetchPresets();
    }
  }, [activeTab, fetchPresets]);

  const createPresetFromCurrentMods = useCallback(async () => {
    const name = newPresetName.trim();
    if (!name || dirty) return;
    setSavingPreset(true);
    try {
      const mods = [...systemManagedMods, ...enabledMods].map(toModPayload);
      await apiClient.post('/servers/presets', { name, mods });
      toast({
        title: 'Preset saved',
        description: `"${name}" saved with ${mods.length} mod${mods.length === 1 ? '' : 's'}.`,
      });
      setSavePresetOpen(false);
      setNewPresetName('');
      await fetchPresets();
    } catch (error) {
      const detail = error.response?.data?.detail;
      toast({
        title: 'Unable to save preset',
        description: (typeof detail === 'string' ? detail : detail?.message) || 'The mod preset could not be created.',
      });
    } finally {
      setSavingPreset(false);
    }
  }, [dirty, enabledMods, fetchPresets, newPresetName, systemManagedMods]);

  const deletePreset = useCallback(async (preset) => {
    if (!preset?.id) return;
    if (!(await confirm({
      title: 'Delete Mod Preset',
      description: `Delete preset "${preset.name || preset.id}"? This cannot be undone.`,
      destructive: true,
      confirmLabel: 'Delete',
    }))) {
      return;
    }
    setDeletingPresetId(preset.id);
    try {
      await apiClient.delete(`/servers/presets/${preset.id}`);
      toast({ title: 'Preset deleted', description: preset.name || preset.id });
      await fetchPresets();
    } catch (error) {
      const detail = error.response?.data?.detail;
      toast({
        title: 'Unable to delete preset',
        description: (typeof detail === 'string' ? detail : detail?.message) || 'The mod preset could not be deleted.',
      });
    } finally {
      setDeletingPresetId(null);
    }
  }, [confirm, fetchPresets]);

  const applyPreset = useCallback(async (preset) => {
    if (!preset?.id || !canManage || dirty) return;
    if (!(await confirm({
      title: 'Apply Mod Preset',
      description: `Replace this server's editable load order with preset "${preset.name || preset.id}"? The deployed load order changes immediately.`,
      destructive: true,
      confirmLabel: 'Apply preset',
    }))) return;

    setApplyingPresetId(preset.id);
    try {
      await apiClient.post(`/servers/${serverId}/mods/import-json`, {
        mods: preset.mods || [],
      }, {
        validateStatus: (status) => status < 400,
      });
      setDirty(false);
      await fetchServer(true);
      await fetchDownloadHistory();
      toast({
        title: 'Preset applied',
        description: `"${preset.name || preset.id}" is now the saved load order for this server.`,
      });
    } catch (error) {
      const detail = error.response?.data?.detail;
      toast({
        title: 'Unable to apply preset',
        description: (typeof detail === 'string' ? detail : detail?.message) || 'The preset could not be applied to this server.',
      });
    } finally {
      setApplyingPresetId(null);
    }
  }, [canManage, confirm, dirty, fetchDownloadHistory, fetchServer, server?.name, serverId, user]);

  const addModDirect = useCallback((mod) => {
    const normalized = normalizeModEntry(mod);
    if (!normalized.mod_id) return;
    if (isRemovedWorkshopMod(normalized)) {
      toast({
        title: 'Mod removed from Workshop',
        description: `${normalized.name || normalized.mod_id} cannot be added. Existing loadout entries are retained for operator review.`,
      });
      return;
    }
    setEnabledMods((prev) => (
      [...systemManagedMods, ...prev].some((entry) => entry.mod_id === normalized.mod_id)
        ? prev
        : [...prev, normalized]
    ));
    setDirty(true);

    // Auto-enrich: trigger background metadata refresh for un-enriched mods
    if (!normalized.metadata_source || normalized.metadata_source === 'manual') {
      apiClient.post(`/servers/workshop/mod/${encodeURIComponent(normalized.mod_id)}/refresh`).catch(() => {
        toast({
          title: 'Workshop details not refreshed',
          description: `${normalized.name || normalized.mod_id} was added, but its Workshop details could not be fetched. Dependency checks may be incomplete until the next refresh.`,
        });
      });
    }
  }, [systemManagedMods]);

  const addManualMod = useCallback(() => {
    const modId = manualMod.mod_id.trim();
    const version = manualMod.version.trim();
    const name = manualMod.name.trim() || modId;

    if (!modId) {
      setManualModError('Enter a mod ID to add an unlisted mod.');
      return;
    }

    if ([...systemManagedMods, ...enabledMods].some((entry) => entry.mod_id === modId)) {
      setManualModError('That mod is already in this server load order.');
      return;
    }

    addModDirect({
      mod_id: modId,
      name,
      version,
      enabled: true,
      metadata_source: 'manual',
    });
    setManualMod({ mod_id: '', name: '', version: '' });
    setManualModError('');
    setActiveTab('load-order');
  }, [addModDirect, enabledMods, manualMod, systemManagedMods]);

  // Workshop browse/search results publish no dependency list, so a mod added
  // straight from the Workshop tab arrives with `dependencies: []` and the
  // dependency prompt below would never fire. Ask the backend for the mod's own
  // record instead — it serves the cached copy when it has one and fetches the
  // detail page when it does not.
  const fetchModMetadata = useCallback(async (modId) => {
    if (!modId) return null;
    try {
      const res = await apiClient.get(`/servers/workshop/mod/${encodeURIComponent(modId)}/details`);
      return res.data || null;
    } catch {
      return null;
    }
  }, []);

  const resolveDependencies = useCallback(async (mod) => {
    const modId = mod.mod_id || mod.modId || '';
    if (!modId) return null;

    setDepLoading(true);
    try {
      const existingIds = [...systemManagedMods, ...enabledMods].map((m) => m.mod_id);
      const res = await apiClient.post(`/servers/${serverId}/mods/resolve-dependencies`, {
        mod_id: modId,
        existing_mod_ids: existingIds,
      });
      return res.data;
    } catch (error) {
      // Falling through to a silent direct add made a failed scan look like
      // "this mod has no dependencies".
      const detail = error.response?.data?.detail;
      toast({
        title: 'Could not resolve dependencies',
        description: (typeof detail === 'string' ? detail : detail?.message)
          || 'The workshop lookup failed. Try again in a moment.',
      });
      return null;
    } finally {
      setDepLoading(false);
    }
  }, [enabledMods, serverId, systemManagedMods]);

  const addModWithDependencies = useCallback((resolvedData) => {
    if (!resolvedData?.resolved) return;
    const removed = resolvedData.resolved.filter(isRemovedWorkshopMod);
    if (removed.length > 0) {
      toast({
        title: 'Dependency is no longer available',
        description: `${removed.map((mod) => mod.name || mod.mod_id).join(', ')} must be replaced or removed before this dependency tree can be added.`,
      });
      return;
    }

    setEnabledMods((prev) => {
      const allExisting = [...systemManagedMods, ...prev];
      const existingIds = new Set(allExisting.map((m) => m.mod_id));
      const toInsert = [];

      // Add items in resolved order (deps first, root mod last)
      for (const dep of resolvedData.resolved) {
        if (!existingIds.has(dep.mod_id)) {
          toInsert.push(normalizeModEntry({
            mod_id: dep.mod_id,
            name: dep.name || dep.mod_id,
            author: dep.author || '',
            // Unpinned: a pin taken at resolve time goes stale and can fall
            // below what another mod requires, which makes the server's
            // Workshop download fail. Pin deliberately from the Versions tab.
            version: '',
            latest_version: dep.version || '',
            thumbnail_url: dep.thumbnail_url || '',
            dependencies: dep.dependencies || [],
            scenario_ids: dep.scenario_ids || [],
            enabled: true,
          }));
        }
      }

      if (toInsert.length === 0) return prev;
      return [...prev, ...toInsert];
    });
    setDirty(true);
    setDepDialogOpen(false);
    setDepResolved(null);
    setDepSourceMod(null);
  }, [systemManagedMods]);

  const addMod = useCallback(async (mod) => {
    const normalized = normalizeModEntry(mod);
    if (!normalized.mod_id) return;
    // Workshop rows and detail records carry the mod's current release as
    // `version`; keeping it pinned the mod at that release forever. Only a
    // manual entry or an explicit pin sets a version.
    if (normalized.metadata_source !== 'manual' && normalized.version) {
      normalized.latest_version = normalized.version;
      normalized.version = '';
    }
    if (isRemovedWorkshopMod(normalized)) {
      addModDirect(normalized);
      return;
    }

    // Check if already added
    const allMods = [...systemManagedMods, ...enabledMods];
    if (allMods.some((entry) => entry.mod_id === normalized.mod_id)) return;

    // Enrich first: a mod picked from Workshop browse/search carries no
    // dependency list, so without this the prompt below never fires and the mod
    // is added with its dependencies silently unaccounted for.
    let candidate = normalized;
    if ((normalized.dependencies || []).length === 0) {
      const metadata = await fetchModMetadata(normalized.mod_id);
      const metadataDeps = metadata?.dependencies || [];
      if (metadataDeps.length > 0) {
        candidate = normalizeModEntry({
          ...normalized,
          name: normalized.name && normalized.name !== normalized.mod_id
            ? normalized.name
            : (metadata.name || normalized.name),
          author: normalized.author || metadata.author || '',
          version: normalized.version || '',
          latest_version: normalized.latest_version || metadata.version || '',
          thumbnail_url: normalized.thumbnail_url || metadata.thumbnail_url || '',
          dependencies: metadataDeps,
          scenario_ids: (normalized.scenario_ids || []).length
            ? normalized.scenario_ids
            : (metadata.scenario_ids || []),
        });
      }
    }

    // Check if mod has known dependencies
    const deps = candidate.dependencies || [];
    const existingIds = new Set(allMods.map((m) => m.mod_id));
    const hasUnresolvedDeps = deps.some((d) => {
      const depId = d.mod_id || d.modId || '';
      return depId && !existingIds.has(depId);
    });

    if (hasUnresolvedDeps) {
      // Auto-prompt: resolve dependencies
      setDepSourceMod(candidate);
      const resolved = await resolveDependencies(candidate);
      if (resolved && resolved.new_count > 0) {
        setDepResolved(resolved);
        setDepDialogOpen(true);
        return; // Wait for user action in the dialog
      }
      if (resolved && resolved.partial && !resolved.new_count) {
        // The scan ran out of budget before it could see the additions; adding
        // the mod without them is what we want to avoid, so stop here and let
        // the operator retry once the background refresh has caught up.
        toast({
          title: 'Dependency scan incomplete',
          description: `${candidate.name || candidate.mod_id} was not added: the Workshop lookup ran out of time before every dependency was found. Try again in a moment.`,
        });
        return;
      }
    }

    // No unresolved deps or resolution failed — add directly
    addModDirect(candidate);
  }, [addModDirect, enabledMods, fetchModMetadata, resolveDependencies, systemManagedMods]);

  const handleResolveDepsForExisting = useCallback(async (mod) => {
    setDepSourceMod(mod);
    const resolved = await resolveDependencies(mod);
    if (resolved) {
      setDepResolved(resolved);
      setDepDialogOpen(true);
    }
  }, [resolveDependencies]);

  const resolveAllDependencies = useCallback(async () => {
    setResolveAllOpen(true);
    setResolveAllTab('additions');
    setResolveAllLoading(true);
    setResolveAllData(null);
    try {
      const modIds = [...systemManagedMods, ...enabledMods]
        .map((m) => m.mod_id)
        .filter(Boolean);
      const res = await apiClient.post(`/servers/${serverId}/mods/resolve-all-dependencies`, {
        mod_ids: modIds,
      });
      setResolveAllData(res.data);
    } catch (error) {
      const detail = error.response?.data?.detail;
      toast({
        title: 'Dependency scan failed',
        description: (typeof detail === 'string' ? detail : detail?.message)
          || 'Could not resolve loadout dependencies.',
      });
      // Keep the dialog in a failed state: filling it with an empty result made
      // a dead scan read as "every dependency is already in your loadout".
      setResolveAllData({
        error: true,
        message: (typeof detail === 'string' ? detail : detail?.message)
          || 'The scan did not complete. Try again in a moment.',
        additions: [],
        tree: [],
        addition_count: 0,
        provider_count: 0,
      });
    } finally {
      setResolveAllLoading(false);
    }
  }, [enabledMods, serverId, systemManagedMods]);

  const openHistory = useCallback(() => setHistoryOpen(true), []);

  // Fetching, searching, snapshots, comparison and revert all live in
  // ModRevisionHistory; this module only has to refresh the loadout once a
  // revert lands.
  const handleReverted = useCallback(async () => {
    setDirty(false);
    await fetchServer(true);
  }, [fetchServer]);

  const addAllResolvedDeps = useCallback(() => {
    const additions = resolveAllData?.additions || [];
    if (additions.length === 0) { setResolveAllOpen(false); return; }

    setEnabledMods((prev) => {
      const existingIds = new Set([...systemManagedMods, ...prev].map((m) => m.mod_id));
      const toInsert = [];
      for (const dep of additions) {
        if (dep.mod_id && !existingIds.has(dep.mod_id)) {
          existingIds.add(dep.mod_id);
          toInsert.push(normalizeModEntry({
            mod_id: dep.mod_id,
            name: dep.name || dep.mod_id,
            author: dep.author || '',
            version: '',
            latest_version: dep.version || '',
            thumbnail_url: dep.thumbnail_url || '',
            dependencies: dep.dependencies || [],
            scenario_ids: dep.scenario_ids || [],
            dependency_of: dep.dependency_of || [],
            enabled: true,
          }));
        }
      }
      if (toInsert.length === 0) return prev;
      // Dependencies load before dependents — prepend so they initialize first.
      return [...toInsert, ...prev];
    });
    setDirty(true);
    setResolveAllOpen(false);
    setResolveAllData(null);
    toast({
      title: 'Dependencies added',
      description: `${additions.length} dependency mod${additions.length === 1 ? '' : 's'} added to the load order. Deploy to persist.`,
    });
  }, [resolveAllData, systemManagedMods]);

  const moveModToIndex = useCallback((fromIndex, toIndex) => {
    setEnabledMods((prev) => {
      if (fromIndex === toIndex) return prev;
      if (fromIndex < 0 || fromIndex >= prev.length) return prev;
      if (toIndex < 0 || toIndex >= prev.length) return prev;
      const clone = [...prev];
      const [moved] = clone.splice(fromIndex, 1);
      clone.splice(toIndex, 0, moved);
      return clone;
    });
    setDirty(true);
  }, []);

  const startDragMod = useCallback((event, index) => {
    setDraggedModIndex(index);
    setDropTargetIndex(index);
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', String(index));
    }
  }, []);

  const moveMod = useCallback((index, delta) => {
    moveModToIndex(index, index + delta);
  }, [moveModToIndex]);

  const startOrderEdit = useCallback((index) => {
    setEditingOrderIndex(index);
    setOrderInputValue(String(index + 1));
  }, []);

  const cancelOrderEdit = useCallback(() => {
    setEditingOrderIndex(null);
    setOrderInputValue('');
  }, []);

  const commitOrderEdit = useCallback((fromIndex) => {
    // Decide the move from the rendered list. Reading a flag set inside the
    // state updater only worked when React ran the updater eagerly, so a typed
    // position often reordered the list without marking it dirty (Deploy
    // stayed disabled and the unsaved-changes guard never fired).
    const parsed = parseInt(orderInputValue, 10);
    const count = enabledMods.length;
    const toIndex = Math.min(Math.max(parsed, 1), count) - 1;
    const willMove = !Number.isNaN(parsed) && count > 0
      && fromIndex >= 0 && fromIndex < count && toIndex !== fromIndex;
    if (willMove) {
      setEnabledMods((prev) => {
        if (fromIndex >= prev.length) return prev;
        const clone = [...prev];
        const [entry] = clone.splice(fromIndex, 1);
        clone.splice(Math.min(toIndex, clone.length), 0, entry);
        return clone;
      });
      setDirty(true);
    }
    setEditingOrderIndex(null);
    setOrderInputValue('');
  }, [enabledMods.length, orderInputValue]);

  const clearAllVersionLocks = useCallback(() => {
    setEnabledMods((prev) => prev.map((mod) => (mod.version ? { ...mod, version: '' } : mod)));
    setDirty(true);
  }, []);

  const toggleMod = useCallback((index) => {
    setEnabledMods((prev) => prev.map((mod, current) => (
      current === index ? { ...mod, enabled: !mod.enabled } : mod
    )));
    setDirty(true);
  }, []);

  const removeMod = useCallback((index) => {
    setEnabledMods((prev) => prev.filter((_, current) => current !== index));
    setDirty(true);
  }, []);

  const saveMods = useCallback(async () => {
    setSaving(true);
    try {
      const modsPayload = {
        mods: [...systemManagedMods, ...enabledMods].map(toModPayload),
      };
      await apiClient.put(`/servers/${serverId}/mods`, modsPayload, {
        validateStatus: (s) => s < 400,
      });
      setDirty(false);
      await fetchServer(true);
      await fetchDownloadHistory();
      // Signal ScenarioSelector (in Settings tab) to re-fetch after mods change;
      // the backend ingestion runs in the background so scenarios from newly
      // installed mods should be available shortly after save.
      if (bumpScenarioRefresh) bumpScenarioRefresh();
      return true;
    } catch (error) {
      toast({
        title: 'Unable to deploy load order',
        description: formatApiError(error, 'The mod load order could not be saved.'),
      });
      return false;
    } finally {
      setSaving(false);
    }
  }, [bumpScenarioRefresh, enabledMods, fetchDownloadHistory, fetchServer, server?.name, serverId, systemManagedMods, user]);

  const discardModsChanges = useCallback(() => {
    setEnabledMods((server?.mods || []).map(normalizeModEntry).filter((mod) => !mod.system_managed));
    setDirty(false);
  }, [server?.mods]);

  useEffect(() => registerDirtySource({
    id: 'mods-load-order',
    label: 'Mods load order',
    summary: `${enabledMods.length} editable mod${enabledMods.length === 1 ? '' : 's'} pending deployment`,
    dirty,
    onSave: saveMods,
    onDiscard: discardModsChanges,
    onSaved: () => setDirty(false),
  }), [dirty, discardModsChanges, enabledMods.length, registerDirtySource, saveMods, server?.name, serverId]);

  const mirrorTargets = useMemo(
    () => managedServers.filter((managedServer) => String(managedServer.id) !== String(serverId)),
    [managedServers, serverId],
  );

  const selectedMirrorServers = useMemo(
    () => mirrorTargets.filter((target) => mirrorSelectedTargets.includes(target.id)),
    [mirrorSelectedTargets, mirrorTargets],
  );

  const savedEditableModCount = useMemo(
    () => (server?.mods || []).filter((mod) => !mod.system_managed).length,
    [server?.mods],
  );

  const toggleMirrorTarget = useCallback((targetId) => {
    setMirrorSelectedTargets((prev) => (
      prev.includes(targetId)
        ? prev.filter((id) => id !== targetId)
        : [...prev, targetId]
    ));
  }, []);

  const updateMirrorOption = useCallback((key, value) => {
    setMirrorOptions((prev) => ({ ...prev, [key]: value }));
  }, []);

  const executeMirror = useCallback(async () => {
    if (dirty || mirrorSelectedTargets.length === 0 || !canManage) return;
    setMirrorRunning(true);
    setMirrorError('');
    setMirrorResults([]);
    try {
      const mirrorPayload = {
        target_server_ids: mirrorSelectedTargets,
        preserve_system_managed: mirrorOptions.preserve_system_managed,
        include_disabled: mirrorOptions.include_disabled,
        include_pinned_versions: mirrorOptions.include_pinned_versions,
        create_backups: mirrorOptions.create_backups,
        restart_targets: mirrorOptions.restart_mode === 'restart',
        reconfigure_targets: mirrorOptions.restart_mode === 'reconfigure',
      };
      const res = await apiClient.post(`/servers/${serverId}/mods/mirror`, mirrorPayload, {
        validateStatus: (s) => s < 400,
      });
      setMirrorResults(res.data?.results || []);
      setMirrorConfirmOpen(false);
      await fetchServer(true);
      await fetchDownloadHistory();
      const postActionFailures = res.data?.post_action_failures || 0;
      toast({
        title: postActionFailures ? 'Mirror completed with runtime warnings' : 'Mirror operation completed',
        description: `${res.data?.succeeded || 0} target${res.data?.succeeded === 1 ? '' : 's'} updated, ${res.data?.failed || 0} failed${postActionFailures ? `, ${postActionFailures} restart/reconfigure action${postActionFailures === 1 ? '' : 's'} failed` : ''}.`,
      });
    } catch (error) {
      const detail = formatApiError(error, 'Mirror operation failed.');
      setMirrorError(detail);
      toast({ title: 'Mirror operation failed', description: detail });
    } finally {
      setMirrorRunning(false);
    }
  }, [canManage, dirty, fetchDownloadHistory, fetchServer, mirrorOptions, mirrorSelectedTargets, server?.name, serverId, user]);

  const validateMods = useCallback(async () => {
    setValidating(true);
    try {
      const res = await apiClient.post(`/servers/${serverId}/mods/validate`, {
        // Versions are sent so pins below what another mod requires are caught.
        mods: enabledMods.map((mod) => ({ mod_id: mod.mod_id, name: mod.name, version: mod.version || '' })),
      });
      setValidationIssues(res.data?.issues || []);
    } catch {
      setValidationIssues([{ message: 'Validation endpoint is unavailable.' }]);
    } finally {
      setValidating(false);
    }
  }, [enabledMods, serverId]);

  const openModDetail = useCallback((mod) => {
    setSelectedMod(normalizeModEntry(mod));
    setDetailOpen(true);
  }, []);

  const handlePinVersion = useCallback((modId, version) => {
    setEnabledMods((prev) =>
      prev.map((m) => m.mod_id === modId ? { ...m, version: version || '' } : m),
    );
    setDirty(true);
  }, []);

  const exportMods = useCallback(async () => {
    setExporting(true);
    try {
      const format = exportMode === 'config' ? '?format=config' : '';
      const res = await apiClient.get(`/servers/${serverId}/mods/export-json${format}`);
      setExportPayload(JSON.stringify(res.data, null, 2));
    } finally {
      setExporting(false);
    }
  }, [serverId, exportMode]);

  const handleFileImport = useCallback((event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      setImportPayload(e.target.result);
    };
    reader.readAsText(file);
    // Reset input so the same file can be re-selected
    event.target.value = '';
  }, []);

  const importMods = useCallback(async () => {
    setImportError('');
    let mods;
    try {
      mods = parseImportPayload(importPayload);
    } catch (error) {
      setImportError(formatApiError(error, error?.message || 'Import failed. Use a JSON array or an object with a "mods" array.'));
      return;
    }
    // Import replaces the deployed loadout outright and discards any draft.
    if (!(await confirm({
      title: 'Replace Server Mod List',
      description: `Replace ${server?.name || 'this server'}'s deployed mods with the ${mods.length} imported mod${mods.length === 1 ? '' : 's'}?${dirty ? ' Your unsaved load-order changes will be discarded.' : ''} The current list stays in mod history.`,
      destructive: true,
      confirmLabel: 'Replace mod list',
    }))) {
      return;
    }
    setImporting(true);
    try {
      await apiClient.post(`/servers/${serverId}/mods/import-json`, { mods }, {
        validateStatus: (s) => s < 400,
      });
      setDirty(false);
      await fetchServer(true);
      await fetchDownloadHistory();
    } catch (error) {
      setImportError(formatApiError(error, 'Import failed. Use a JSON array or an object with a "mods" array.'));
    } finally {
      setImporting(false);
    }
  }, [confirm, dirty, fetchDownloadHistory, fetchServer, importPayload, server?.name, serverId, user]);

  const enabledCount = useMemo(
    () => enabledMods.filter((mod) => mod.enabled).length,
    [enabledMods],
  );

  const modNameById = useMemo(() => {
    const map = {};
    for (const mod of [...systemManagedMods, ...enabledMods]) {
      if (mod.mod_id) map[mod.mod_id] = mod.name || mod.mod_id;
    }
    return map;
  }, [enabledMods, systemManagedMods]);

  const labelForModIds = useCallback((ids = []) => {
    const names = ids.map((id) => modNameById[id] || id);
    if (names.length === 0) return '';
    if (names.length === 1) return names[0];
    return `${names[0]} +${names.length - 1} more`;
  }, [modNameById]);

  return (
    <div className="space-y-5">
      {confirmDialog}
      {/* The module header above already names this page; this row is only
          the loadout-wide actions. */}
      <div className="flex flex-wrap items-center justify-end gap-3">
        <div className="flex flex-wrap items-center justify-end gap-2">
          {systemManagedMods.length > 0 && (
            <Badge variant="outline" className="border-blue-600/30 text-blue-300">
              {systemManagedMods.length} system-managed admin tool mod{systemManagedMods.length > 1 ? 's' : ''}
            </Badge>
          )}
          {dirty && (
            <Badge variant="outline" className="border-amber-500/30 text-amber-300">
              Unsaved load order changes
            </Badge>
          )}
          <Button
            size="sm"
            variant="outline"
            onClick={clearAllVersionLocks}
            disabled={!canManage || !enabledMods.some((mod) => mod.version)}
            className="h-8 border-zinc-800 text-xs text-mil-muted"
          >
            <Lock className="mr-1 h-3.5 w-3.5" />
            Clear all version locks
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={resolveAllDependencies}
            disabled={enabledMods.length === 0}
            className="h-8 border-zinc-800 text-xs text-mil-muted"
          >
            <GitBranch className="mr-1 h-3.5 w-3.5" />
            Resolve dependencies
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={openHistory}
            className="h-8 border-zinc-800 text-xs text-mil-muted"
          >
            <History className="mr-1 h-3.5 w-3.5" />
            History
          </Button>
          <Button size="sm" variant="outline" onClick={validateMods} disabled={validating} className="h-8 border-zinc-800 text-xs text-mil-muted">
            {validating ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Shield className="mr-1 h-3.5 w-3.5" />}
            Validate
          </Button>
          <Button
            size="sm"
            onClick={saveMods}
            disabled={!dirty || saving || !canManage}
            className="h-8 bg-brand text-black transition-all hover:bg-brand-light hover:shadow-[0_0_18px_rgba(232,131,58,0.24)]"
          >
            {saving ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Save className="mr-1 h-3.5 w-3.5" />}
            Deploy load order
          </Button>
        </div>
      </div>

      {validationIssues.length > 0 && (
        <div className="space-y-1.5 rounded-lg border border-amber-500/25 bg-amber-500/5 p-3">
          {validationIssues.map((issue, index) => {
            const tone = issue.severity === 'high' || issue.severity === 'critical'
              ? 'text-red-300'
              : issue.severity === 'info' ? 'text-mil-muted' : 'text-amber-200';
            const pinned = issue.type === 'version_conflict' || issue.type === 'pinned_outdated';
            return (
              <div key={`${issue.message || issue.type}-${index}`} className={`flex flex-wrap items-center justify-between gap-2 text-xs ${tone}`}>
                <span className="min-w-0 flex-1">{issue.message || issue.type}</span>
                {pinned && canManage && enabledMods.some((mod) => mod.mod_id === issue.mod_id && mod.version) ? (
                  <button
                    type="button"
                    onClick={() => {
                      handlePinVersion(issue.mod_id, '');
                      setValidationIssues((prev) => prev.filter((item) => item !== issue));
                    }}
                    className="shrink-0 rounded border border-current/30 px-2 py-0.5 text-[11px] hover:bg-white/5"
                  >
                    Unpin
                  </button>
                ) : null}
              </div>
            );
          })}
        </div>
      )}

      {systemManagedMods.length > 0 && (
        <div className="rounded-lg border border-blue-600/20 bg-blue-600/5 p-3 text-xs text-blue-200">
          Admin tool dependencies such as Server Admin Tools are system-managed. They stay in the deployed config, but they are hidden from the editable load order here so users do not accidentally break dashboard features.
        </div>
      )}

      <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-4">
        <TabsList className="grid h-auto grid-cols-5 rounded-xl border border-zinc-800 bg-mil-bg-deep/60 p-1">
          <TabsTrigger value="workshop" className="data-[state=active]:bg-brand data-[state=active]:text-black">Workshop</TabsTrigger>
          <TabsTrigger value="load-order" className="data-[state=active]:bg-brand data-[state=active]:text-black">Load Order</TabsTrigger>
          <TabsTrigger value="presets" className="data-[state=active]:bg-brand data-[state=active]:text-black">Presets</TabsTrigger>
          <TabsTrigger value="mirror" className="data-[state=active]:bg-brand data-[state=active]:text-black">Mirror</TabsTrigger>
          <TabsTrigger value="batch" className="data-[state=active]:bg-brand data-[state=active]:text-black">Batch</TabsTrigger>
        </TabsList>

        <TabsContent value="workshop" className="space-y-4">
          <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
            <Card className="border-zinc-800 bg-mil-bg-deep/60">
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-sm tracking-[0.06em] text-mil-fg">
                  <Package className="h-4 w-4 text-brand" /> LIVE WORKSHOP BROWSER
                </CardTitle>
                {/* Wraps by the card's own width. A viewport-keyed grid gave the
                    search box a zero-width column inside the narrow desktop card. */}
                <div className="flex flex-wrap gap-2">
                  <div className="relative min-w-0 flex-[2_1_16rem]">
                    <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-mil-dim" />
                    <Input
                      value={workshopSearch}
                      onChange={(event) => setWorkshopSearch(event.target.value)}
                      onKeyDown={(event) => event.key === 'Enter' && submitWorkshopSearch()}
                      placeholder="Search mods or paste a mod ID"
                      className="h-9 border-zinc-800 bg-mil-bg-deep/50 pl-9 text-sm text-white placeholder:text-mil-dim"
                    />
                  </div>
                  <select
                    value={workshopSort}
                    onChange={(event) => {
                      setWorkshopPage(1);
                      setWorkshopSort(event.target.value);
                    }}
                    aria-label="Sort workshop results"
                    className="h-9 min-w-0 flex-[1_1_9rem] rounded-md border border-zinc-800 bg-mil-bg-deep/50 px-3 text-sm text-white"
                  >
                    <option value="popularity">Popularity</option>
                    <option value="newest">Newest</option>
                    <option value="subscribers">Subscribers</option>
                    <option value="versionSize">Version size</option>
                  </select>
                  <Input
                    value={workshopTags}
                    onChange={(event) => setWorkshopTags(event.target.value)}
                    placeholder="Tags (comma separated)"
                    aria-label="Filter by workshop tags"
                    className="h-9 min-w-0 flex-[1_1_9rem] border-zinc-800 bg-mil-bg-deep/50 text-sm text-white placeholder:text-mil-dim"
                  />
                  <Button size="sm" onClick={submitWorkshopSearch} className="h-9 shrink-0 bg-brand text-black hover:bg-brand-light">
                    {workshopLoading ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="mr-1 h-3.5 w-3.5" />}
                    Refresh
                  </Button>
                </div>
                {(workshopError || (workshopLoading && workshopSource === 'cache')) && (
                  <p className={`text-xs ${workshopError ? 'text-amber-300' : 'text-mil-muted'}`} role="status">
                    {workshopError || 'Showing indexed results while the live Workshop refreshes…'}
                  </p>
                )}
              </CardHeader>
              <CardContent className="space-y-2">
                {workshopLoading && workshopMods.length === 0 ? (
                  <div className="flex items-center justify-center py-12">
                    <Loader2 className="h-5 w-5 animate-spin text-brand" />
                  </div>
                ) : workshopMods.length === 0 ? (
                  <div className="flex flex-col items-center justify-center py-12 text-mil-dim">
                    <Package className="mb-3 h-8 w-8 text-mil-dim" />
                    <p className="text-sm">No workshop results yet.</p>
                    <p className="mt-1 text-xs">Search by mod name, tag, or ID to pull live Workshop results into the dashboard, or add an unlisted mod manually from the sidebar.</p>
                  </div>
                ) : (
                  workshopMods.map((mod) => {
                    const isAdded = [...systemManagedMods, ...enabledMods].some((entry) => entry.mod_id === mod.mod_id);
                    const isRemoved = isRemovedWorkshopMod(mod);
                    return (
                      <div key={mod.mod_id} className={`flex items-center gap-2 rounded-xl border bg-zinc-950/70 p-3 sm:gap-3 ${isRemoved ? 'border-red-500/40' : 'border-zinc-800/70'}`}>
                        {mod.thumbnail_url ? (
                          <img src={mod.thumbnail_url} alt="" className="h-10 w-10 shrink-0 rounded-lg object-cover sm:h-14 sm:w-14" />
                        ) : (
                          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-zinc-900 sm:h-14 sm:w-14">
                            <Puzzle className="h-4 w-4 text-mil-dim sm:h-5 sm:w-5" />
                          </div>
                        )}
                        <button type="button" className="min-w-0 flex-1 text-left" onClick={() => openModDetail(mod)}>
                          <div className="text-sm font-medium leading-snug text-mil-fg" style={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{mod.name || mod.mod_id}</div>
                          <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-mil-dim">
                            <span className="font-mono text-mil-dim break-all">{mod.mod_id}</span>
                            {mod.author && <span>by {mod.author}</span>}
                            {isRemoved && (
                              <Badge variant="outline" className="border-red-500/40 text-[11px] text-red-300">
                                <AlertTriangle className="mr-1 h-2.5 w-2.5" />Removed from Workshop
                              </Badge>
                            )}
                            {mod.tags?.slice(0, 2).map((tag) => (
                              <Badge key={tag} variant="outline" className="border-zinc-700 text-[11px] text-mil-muted">{tag}</Badge>
                            ))}
                          </div>
                        </button>
                        <Button
                          size="sm"
                          onClick={() => addMod(mod)}
                          disabled={isAdded || isRemoved}
                          title={isRemoved ? 'This mod is no longer available from the Workshop' : undefined}
                          aria-label={isRemoved
                            ? `Removed from Workshop: ${mod.name || mod.mod_id}`
                            : isAdded
                              ? `Already in load order: ${mod.name || mod.mod_id}`
                              : `Add ${mod.name || mod.mod_id} to load order`}
                          className={isRemoved
                            ? 'h-8 shrink-0 border border-red-500/30 bg-transparent text-red-300'
                            : isAdded
                              ? 'h-8 shrink-0 border border-green-500/30 bg-transparent text-green-300'
                              : 'h-8 shrink-0 bg-brand text-black hover:bg-brand-light'}
                        >
                          {isRemoved
                            ? <AlertTriangle className="h-3.5 w-3.5" />
                            : isAdded
                              ? <CheckCircle className="h-3.5 w-3.5" />
                              : <Plus className="h-3.5 w-3.5" />}
                        </Button>
                      </div>
                    );
                  })
                )}
              </CardContent>
              {/* Pagination */}
              {workshopTotalPages > 1 && (
                <div className="flex items-center justify-between border-t border-zinc-800 px-4 py-3">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setWorkshopPage((p) => Math.max(1, p - 1))}
                    disabled={workshopPage <= 1 || workshopLoading}
                    className="h-8 border-zinc-700 text-xs text-mil-muted hover:bg-zinc-900 hover:text-white"
                  >
                    Previous
                  </Button>
                  <span className="text-xs text-mil-muted">
                    Page {workshopPage} of {workshopTotalPages}
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setWorkshopPage((p) => Math.min(workshopTotalPages, p + 1))}
                    disabled={workshopPage >= workshopTotalPages || workshopLoading}
                    className="h-8 border-zinc-700 text-xs text-mil-muted hover:bg-zinc-900 hover:text-white"
                  >
                    Next
                  </Button>
                </div>
              )}
            </Card>

            <div className="space-y-4">
              <Card className="border-zinc-800 bg-mil-bg-deep/60">
                <CardHeader className="pb-3">
                  <CardTitle className="flex items-center gap-2 text-sm tracking-[0.06em] text-mil-fg">
                    <Plus className="h-4 w-4 text-brand" /> MANUAL ADD
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  <p className="text-xs text-mil-dim">
                    Use this for private, unlisted, or not-yet-indexed mods when the workshop browser cannot surface them.
                  </p>
                  <Input
                    value={manualMod.mod_id}
                    onChange={(event) => { setManualMod((prev) => ({ ...prev, mod_id: event.target.value })); setManualModError(''); }}
                    placeholder="Mod ID"
                    className="h-9 border-zinc-800 bg-mil-bg-deep/50 text-sm text-white placeholder:text-mil-dim"
                  />
                  <Input
                    value={manualMod.name}
                    onChange={(event) => setManualMod((prev) => ({ ...prev, name: event.target.value }))}
                    placeholder="Display name (optional)"
                    className="h-9 border-zinc-800 bg-mil-bg-deep/50 text-sm text-white placeholder:text-mil-dim"
                  />
                  <Input
                    value={manualMod.version}
                    onChange={(event) => setManualMod((prev) => ({ ...prev, version: event.target.value }))}
                    placeholder="Pinned version (optional)"
                    className="h-9 border-zinc-800 bg-mil-bg-deep/50 text-sm text-white placeholder:text-mil-dim"
                  />
                  {manualModError ? <p className="text-xs text-red-400">{manualModError}</p> : null}
                  <Button size="sm" onClick={addManualMod} disabled={!canManage} className="h-9 bg-brand text-black hover:bg-brand-light">
                    <Plus className="mr-1 h-3.5 w-3.5" />
                    Add to load order
                  </Button>
                </CardContent>
              </Card>

              <Card className="border-zinc-800 bg-mil-bg-deep/60">
                <CardHeader className="pb-3">
                  <CardTitle className="flex items-center gap-2 text-sm tracking-[0.06em] text-mil-fg">
                    <History className="h-4 w-4 text-brand" /> DOWNLOAD HISTORY
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-2">
                  {historyLoading ? (
                    <div className="flex items-center justify-center py-12">
                      <Loader2 className="h-5 w-5 animate-spin text-brand" />
                    </div>
                  ) : downloadHistory.length === 0 ? (
                    <p className="text-xs text-mil-dim">No mod download history has been recorded yet.</p>
                  ) : (
                    downloadHistory.slice(0, 12).map((entry) => (
                      <div key={`${entry.mod_id}-${entry.server_id}-${entry.downloaded_at}`} className="rounded-xl border border-zinc-800/70 bg-zinc-950/70 p-3">
                        <div className="text-sm text-mil-fg">{entry.mod_name || entry.mod_id}</div>
                        <div className="mt-1 text-[11px] text-mil-dim">
                          {entry.server_id === serverId ? 'This server' : (serverNameById[entry.server_id] || entry.server_id)} • {entry.downloaded_by || 'Unknown operator'}
                        </div>
                        <div className="mt-1 text-[11px] text-mil-dim">
                          {entry.downloaded_at ? new Date(entry.downloaded_at).toLocaleString() : 'Unknown time'}
                        </div>
                      </div>
                    ))
                  )}
                </CardContent>
              </Card>
            </div>
          </div>
        </TabsContent>

        <TabsContent value="load-order" className="space-y-4">
          <Card className="border-zinc-800 bg-mil-bg-deep/60">
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-sm tracking-[0.06em] text-mil-fg">
                <Puzzle className="h-4 w-4 text-brand" /> LOAD ORDER
                <Badge variant="outline" className="ml-auto border-zinc-700 text-mil-muted">{enabledCount}/{enabledMods.length} enabled</Badge>
              </CardTitle>
              <p className="text-xs text-mil-dim">
                Drag by the grip handle to reorder quickly, or use the arrows for precise single-step moves.
              </p>
              {enabledCount < enabledMods.length && (
                // The API keeps only enabled mods, so a switched-off mod leaves
                // the loadout on deploy rather than staying listed as disabled.
                <p role="status" className="mt-1 text-xs text-amber-300">
                  {enabledMods.length - enabledCount} mod{enabledMods.length - enabledCount === 1 ? ' is' : 's are'} switched off and will be removed from the loadout when you deploy. Mod history keeps the previous list.
                </p>
              )}
            </CardHeader>
            <CardContent className="space-y-2">
              {enabledMods.length > 0 && (
                <div className="flex flex-wrap items-center gap-2 pb-1">
                  <div className="relative min-w-[12rem] flex-1">
                    <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-mil-dim" />
                    <Input
                      value={loadOrderSearch}
                      onChange={(event) => setLoadOrderSearch(event.target.value)}
                      placeholder="Search this load order by name, ID, version, author, or tag"
                      aria-label="Search the load order"
                      className="h-8 border-zinc-700 bg-mil-bg-deep/70 pl-8 text-xs text-white placeholder:text-mil-dim"
                    />
                  </div>
                  <span className="text-[11px] text-mil-dim">
                    {loadOrderFiltered
                      ? `${visibleLoadOrder.length} of ${enabledMods.length} shown`
                      : `${enabledMods.length} mods`}
                  </span>
                  {loadOrderFiltered && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setLoadOrderSearch('')}
                      className="h-8 border-zinc-700 text-[11px] text-mil-muted hover:border-brand/40 hover:text-brand"
                    >
                      Clear
                    </Button>
                  )}
                </div>
              )}
              {loadOrderFiltered && (
                // Dragging across hidden rows has no honest meaning — the drop
                // target between two visible rows is ambiguous when there are
                // unseen mods between them. Arrows and the position box stay
                // live because both act on absolute positions.
                <p className="pb-1 text-[11px] text-mil-dim">
                  Positions shown are absolute. Drag is disabled while filtering — use the arrows or
                  click a position number to move a mod within the full list.
                </p>
              )}
              {enabledMods.length === 0 ? (
                <CommandEmptyState
                  icon={Puzzle}
                  title="No mods are assigned to this server yet"
                  description="Use the Workshop tab to browse live results or add an unlisted mod manually."
                />
              ) : visibleLoadOrder.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-10 text-mil-dim">
                  <Search className="mb-2 h-7 w-7 text-mil-dim" />
                  <p className="text-sm">No mods match “{loadOrderSearch.trim()}”.</p>
                  <p className="mt-1 text-xs">Clear the search to see all {enabledMods.length} mods.</p>
                </div>
              ) : (
                visibleLoadOrder.map(({ mod, index }) => (
                  <div
                    key={mod.mod_id || index}
                    onDragOver={(event) => {
                      if (draggedModIndex === null || draggedModIndex === index) return;
                      event.preventDefault();
                      if (dropTargetIndex !== index) setDropTargetIndex(index);
                    }}
                    onDrop={(event) => {
                      event.preventDefault();
                      if (draggedModIndex !== null && draggedModIndex !== index) {
                        moveModToIndex(draggedModIndex, index);
                      }
                      setDraggedModIndex(null);
                      setDropTargetIndex(null);
                    }}
                    onDragEnd={() => { setDraggedModIndex(null); setDropTargetIndex(null); }}
                    className={`flex flex-wrap items-start gap-2 rounded-xl border border-zinc-800/70 bg-zinc-950/70 p-3 sm:flex-nowrap sm:items-center sm:gap-3 ${draggedModIndex === index ? 'opacity-70 ring-1 ring-brand/30' : ''} ${dropTargetIndex === index && draggedModIndex !== index ? 'border-brand/50 bg-brand/5' : ''}`}
                  >
                    <button
                      type="button"
                      draggable={!mod.system_managed && canManage && !loadOrderFiltered}
                      onDragStart={(event) => startDragMod(event, index)}
                      onDragEnd={() => { setDraggedModIndex(null); setDropTargetIndex(null); }}
                      disabled={mod.system_managed || !canManage || loadOrderFiltered}
                      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-mil-dim hover:bg-zinc-900 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
                      title={
                        loadOrderFiltered
                          ? 'Clear the search to drag — use the arrows or position number instead'
                          : mod.system_managed ? 'System-managed mod' : 'Drag to reorder'
                      }
                      aria-label={mod.system_managed ? 'System-managed mod' : 'Drag to reorder'}
                    >
                      <GripVertical className="h-4 w-4" />
                    </button>
                    <div className="flex shrink-0 flex-col gap-1 pt-0.5 sm:pt-0">
                      <button
                        type="button"
                        onClick={() => moveMod(index, -1)}
                        disabled={index === 0}
                        className="flex h-8 w-8 items-center justify-center rounded-md text-mil-dim hover:bg-zinc-900 hover:text-white disabled:opacity-30"
                      >
                        <ArrowUp className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => moveMod(index, 1)}
                        disabled={index === enabledMods.length - 1}
                        className="flex h-8 w-8 items-center justify-center rounded-md text-mil-dim hover:bg-zinc-900 hover:text-white disabled:opacity-30"
                      >
                        <ArrowDown className="h-3.5 w-3.5" />
                      </button>
                    </div>
                    <div className="w-7 shrink-0 pt-0.5 text-center sm:w-8 sm:pt-0">
                      {editingOrderIndex === index ? (
                        <Input
                          type="number"
                          min={1}
                          max={enabledMods.length}
                          autoFocus
                          value={orderInputValue}
                          onChange={(event) => setOrderInputValue(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') { event.preventDefault(); commitOrderEdit(index); }
                            else if (event.key === 'Escape') { event.preventDefault(); cancelOrderEdit(); }
                          }}
                          onBlur={cancelOrderEdit}
                          className="h-7 w-8 rounded-md border-zinc-700 bg-mil-bg-deep/70 px-1 text-center text-xs text-white sm:w-9 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                          aria-label={`Load order position for ${mod.name || mod.mod_id}`}
                        />
                      ) : (
                        <button
                          type="button"
                          onClick={() => startOrderEdit(index)}
                          disabled={!canManage || mod.system_managed}
                          className="h-7 w-full rounded-md text-xs text-mil-dim hover:bg-zinc-900 hover:text-white disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-mil-dim"
                          title={mod.system_managed ? 'System-managed mod' : 'Click to set load order position'}
                        >
                          {index + 1}
                        </button>
                      )}
                    </div>
                    {mod.thumbnail_url ? (
                      <img
                        src={mod.thumbnail_url}
                        alt=""
                        loading="lazy"
                        className="h-10 w-10 shrink-0 rounded-lg border border-zinc-800 object-cover"
                      />
                    ) : (
                      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-zinc-800 bg-zinc-900">
                        <Puzzle className="h-4 w-4 text-mil-dim" />
                      </div>
                    )}
                    <button type="button" className="min-w-0 flex-1 text-left" onClick={() => openModDetail(mod)}>
                      <div className="text-sm font-medium leading-snug text-mil-fg" style={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{mod.name}</div>
                      <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] font-mono text-mil-dim">
                        <span className="truncate max-w-[20rem]">{mod.mod_id}</span>
                        {mod.version && (
                          <Badge variant="outline" className="border-blue-500/30 text-[11px] text-blue-300">
                            <Lock className="mr-0.5 h-2 w-2" />v{mod.version}
                          </Badge>
                        )}
                        {(mod.scenario_ids?.length > 0) && (
                          <Badge variant="outline" className="border-purple-500/30 text-[11px] text-purple-300">
                            <Map className="mr-0.5 h-2 w-2" />{mod.scenario_ids.length} scenario{mod.scenario_ids.length > 1 ? 's' : ''}
                          </Badge>
                        )}
                        {mod.local_installed === false && (
                          <Badge variant="outline" className="border-amber-500/30 text-[11px] text-amber-300">
                            <AlertTriangle className="mr-0.5 h-2 w-2" />Not yet installed
                          </Badge>
                        )}
                        {isRemovedWorkshopMod(mod) && (
                          <Badge variant="outline" className="border-red-500/40 text-[11px] text-red-300">
                            <AlertTriangle className="mr-0.5 h-2 w-2" />Removed from Workshop
                          </Badge>
                        )}
                        {mod.dependency_of?.length > 0 && (
                          <Badge
                            variant="outline"
                            className="border-cyan-500/30 text-[11px] text-cyan-300"
                            title={`Dependency of: ${mod.dependency_of.map((id) => modNameById[id] || id).join(', ')}`}
                          >
                            <GitBranch className="mr-0.5 h-2 w-2" />Dependency of {labelForModIds(mod.dependency_of)}
                          </Badge>
                        )}
                      </div>
                    </button>
                    <div className="flex w-full shrink-0 items-center justify-end gap-1 border-t border-zinc-800/50 pt-2 sm:w-auto sm:border-0 sm:pt-0">
                      <Switch
                        checked={mod.enabled}
                        onCheckedChange={() => toggleMod(index)}
                        aria-label={`${mod.enabled ? 'Exclude' : 'Include'} ${mod.name || mod.modId} on deploy`}
                        title={mod.enabled ? 'Included on deploy' : 'Excluded: removed from the loadout on deploy'}
                        className="h-5 w-9"
                      />
                      <Button size="icon" variant="ghost" onClick={() => handleResolveDepsForExisting(mod)} className="h-8 w-8 text-mil-dim hover:text-blue-400" title="Resolve dependencies" aria-label="Resolve dependencies">
                        <GitBranch className="h-4 w-4" />
                      </Button>
                      <Button size="icon" variant="ghost" onClick={() => removeMod(index)} className="h-8 w-8 text-mil-dim hover:text-red-400" aria-label="Remove mod">
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                ))
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="presets" className="space-y-4">
          <Card className="border-zinc-800 bg-mil-bg-deep/60">
            <CardHeader className="pb-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <CardTitle className="flex items-center gap-2 text-sm tracking-[0.06em] text-mil-fg">
                    <Bookmark className="h-4 w-4 text-brand" /> MOD PRESETS
                  </CardTitle>
                  <p className="mt-1 text-xs text-mil-dim">
                    Save this server's currently active mod list as a reusable preset, apply a saved preset to this
                    server, or remove presets you no longer need. Applying a preset replaces the editable load order
                    through the normal mod update path.
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Button size="sm" variant="outline" onClick={fetchPresets} disabled={presetsLoading} className="h-8 border-zinc-700 text-xs text-mil-muted">
                    {presetsLoading ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="mr-1 h-3.5 w-3.5" />}
                    Refresh
                  </Button>
                  <Button
                    size="sm"
                    onClick={() => setSavePresetOpen(true)}
                    disabled={!canManage || dirty || (systemManagedMods.length + enabledMods.length) === 0}
                    title={dirty ? 'Save or discard your unsaved load-order changes first' : undefined}
                    className="h-8 bg-brand text-black hover:bg-brand-light"
                  >
                    <Save className="mr-1 h-3.5 w-3.5" />
                    Save current mods as preset
                  </Button>
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-2">
              {dirty && (
                <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-300">
                  You have unsaved load-order changes. Save or discard them before creating a preset, so the preset
                  reflects what's actually deployed rather than a draft.
                </div>
              )}
              {presetsError && (
                <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-xs text-red-300">
                  {presetsError}
                </div>
              )}
              {presetsLoading ? (
                <CommandLoadingState immersive={false} label="Loading mod presets" rows={3} />
              ) : presets.length === 0 ? (
                <CommandEmptyState
                  icon={Bookmark}
                  title="No mod presets yet"
                  description="Save the currently loaded mod list above to create your first reusable preset."
                />
              ) : (
                presets.map((preset) => {
                  const modCount = (preset.mods || []).length;
                  return (
                    <div key={preset.id} className="flex items-center gap-3 rounded-xl border border-zinc-800/70 bg-zinc-950/70 p-3">
                      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-zinc-800 bg-zinc-900">
                        <Bookmark className="h-4 w-4 text-mil-dim" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-medium text-mil-fg">{preset.name || preset.id}</div>
                        <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-mil-dim">
                          <span>{modCount} mod{modCount === 1 ? '' : 's'}</span>
                          {preset.description && <span className="truncate">{preset.description}</span>}
                        </div>
                      </div>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => applyPreset(preset)}
                        disabled={!canManage || dirty || applyingPresetId === preset.id}
                        title={dirty ? 'Save or discard your draft load-order changes first' : undefined}
                        className="h-8 border-zinc-700 text-xs text-mil-muted hover:border-brand/40 hover:text-brand-light"
                        aria-label={`Apply preset ${preset.name || preset.id}`}
                      >
                        {applyingPresetId === preset.id
                          ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                          : <Upload className="mr-1 h-3.5 w-3.5" />}
                        Apply
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        onClick={() => deletePreset(preset)}
                        disabled={!canManage || deletingPresetId === preset.id}
                        className="h-8 w-8 text-mil-dim hover:text-red-400"
                        aria-label={`Delete preset ${preset.name || preset.id}`}
                      >
                        {deletingPresetId === preset.id
                          ? <Loader2 className="h-4 w-4 animate-spin" />
                          : <Trash2 className="h-4 w-4" />}
                      </Button>
                    </div>
                  );
                })
              )}
            </CardContent>
          </Card>

          <Dialog open={savePresetOpen} onOpenChange={(open) => { if (!open) { setSavePresetOpen(false); setNewPresetName(''); } }}>
            <DialogContent className="w-[95vw] max-w-md border-zinc-800 bg-zinc-950 text-white">
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2 text-brand">
                  <Save className="h-5 w-5" />
                  Save Current Mods as Preset
                </DialogTitle>
              </DialogHeader>
              <div className="space-y-3">
                <p className="text-xs text-mil-muted">
                  Captures the {systemManagedMods.length + enabledMods.length} mod{(systemManagedMods.length + enabledMods.length) === 1 ? '' : 's'} currently
                  active in this server's load order, including system-managed mods.
                </p>
                <Input
                  value={newPresetName}
                  onChange={(event) => setNewPresetName(event.target.value)}
                  placeholder="Preset name"
                  aria-label="Preset name"
                  autoFocus
                  onKeyDown={(event) => { if (event.key === 'Enter' && newPresetName.trim() && !savingPreset) createPresetFromCurrentMods(); }}
                  className="h-9 border-zinc-800 bg-mil-bg-deep/50 text-sm text-white placeholder:text-mil-dim"
                />
                <div className="flex justify-end gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => { setSavePresetOpen(false); setNewPresetName(''); }}
                    disabled={savingPreset}
                    className="border-zinc-700 text-mil-muted"
                  >
                    Cancel
                  </Button>
                  <Button
                    size="sm"
                    onClick={createPresetFromCurrentMods}
                    disabled={!newPresetName.trim() || savingPreset}
                    className="bg-brand text-black hover:bg-brand-light"
                  >
                    {savingPreset ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Save className="mr-1 h-3.5 w-3.5" />}
                    Save preset
                  </Button>
                </div>
              </div>
            </DialogContent>
          </Dialog>
        </TabsContent>

        <TabsContent value="mirror" className="space-y-4">
          <div role="tablist" aria-label="Mirror direction" className="inline-flex rounded-lg border border-white/[0.08] bg-mil-bg-deep/60 p-1">
            {[
              ['pull', 'Pull into this server'],
              ['push', 'Push to other servers'],
            ].map(([value, label]) => (
              <button
                key={value}
                type="button"
                role="tab"
                aria-selected={mirrorDirection === value}
                onClick={() => setMirrorDirection(value)}
                className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                  mirrorDirection === value ? 'bg-brand/15 text-brand-light' : 'text-mil-muted hover:text-mil-fg'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          {mirrorDirection === 'pull' ? (
            <MirrorPullPanel
              server={server}
              serverId={serverId}
              sources={mirrorTargets}
              loadingSources={mirrorLoadingServers}
              onRefreshSources={fetchManagedServers}
              dirty={dirty}
              canManage={canManage}
              user={user}
              onApplied={async () => { await fetchServer(true); await fetchDownloadHistory(); }}
            />
          ) : (
          <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
            <Card className="border-zinc-800 bg-mil-bg-deep/60">
              <CardHeader className="pb-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <CardTitle className="flex items-center gap-2 text-sm tracking-[0.06em] text-mil-fg">
                      <Copy className="h-4 w-4 text-brand" /> MIRROR LOADOUT
                    </CardTitle>
                    <p className="mt-1 text-xs text-mil-dim">
                      Copy the saved editable load order from this server to other managed instances.
                    </p>
                  </div>
                  <Button size="sm" variant="outline" onClick={fetchManagedServers} disabled={mirrorLoadingServers} className="h-8 border-zinc-700 text-xs text-mil-muted">
                    {mirrorLoadingServers ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="mr-1 h-3.5 w-3.5" />}
                    Refresh targets
                  </Button>
                </div>
              </CardHeader>
              <CardContent className="space-y-3">
                {dirty && (
                  <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-200">
                    <div className="flex items-start gap-2">
                      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                      <span>Deploy the local load-order changes before mirroring. Mirror uses the saved server load order as the source.</span>
                    </div>
                  </div>
                )}

                {mirrorError && (
                  <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-xs text-red-300">
                    {mirrorError}
                  </div>
                )}

                {mirrorLoadingServers ? (
                  <div className="flex items-center justify-center py-12 text-mil-dim">
                    <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Loading managed servers...
                  </div>
                ) : mirrorTargets.length === 0 ? (
                  <div className="flex flex-col items-center justify-center rounded-lg border border-zinc-800 bg-mil-bg-deep/40 py-12 text-mil-dim">
                    <Server className="mb-3 h-8 w-8" />
                    <p className="text-sm">No other managed servers are available.</p>
                  </div>
                ) : (
                  <div className="space-y-2">
                    {mirrorTargets.map((target) => {
                      const selected = mirrorSelectedTargets.includes(target.id);
                      const modCount = Array.isArray(target.mods) ? target.mods.length : 0;
                      return (
                        <button
                          key={target.id}
                          type="button"
                          onClick={() => toggleMirrorTarget(target.id)}
                          className={`flex w-full items-center gap-3 rounded-lg border p-3 text-left transition-colors ${
                            selected
                              ? 'border-brand/50 bg-brand/10'
                              : 'border-zinc-800 bg-zinc-950/60 hover:border-zinc-700'
                          }`}
                        >
                          <span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded border ${selected ? 'border-brand bg-brand text-black' : 'border-zinc-700 text-transparent'}`}>
                            <CheckCircle className="h-3.5 w-3.5" />
                          </span>
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="truncate text-sm font-medium text-mil-fg">{target.name || target.id}</span>
                              <Badge variant="outline" className="border-zinc-700 text-[11px] text-mil-muted capitalize">
                                {target.status || 'unknown'}
                              </Badge>
                            </div>
                            <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-mil-dim">
                              <span className="font-mono">{target.id}</span>
                              <span>{modCount} current mod{modCount === 1 ? '' : 's'}</span>
                            </div>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                )}

                {mirrorResults.length > 0 && (
                  <div className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-3">
                    <p className="mb-2 text-xs font-medium text-mil-muted">Last mirror result</p>
                    <div className="space-y-1.5">
                      {mirrorResults.map((result) => (
                        <div key={result.target_server_id} className="flex flex-wrap items-center justify-between gap-2 text-xs">
                          <span className="text-mil-fg">{result.target_name || result.target_server_id}</span>
                          <span className={result.post_action_error ? 'text-amber-300' : (result.ok ? 'text-green-400' : 'text-red-400')}>
                            {result.ok && result.post_action_error
                              ? `${result.mod_count} mods applied, but ${result.post_action_error}`
                              : result.ok
                                ? `${result.mod_count} mods applied${result.backup_id ? `, backup ${result.backup_id}` : ''}`
                                : result.error}
                          </span>
                          {result.scenario_warning ? (
                            <p className="w-full text-[11px] text-red-300">{result.scenario_warning.message}</p>
                          ) : null}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>

            <Card className="border-zinc-800 bg-mil-bg-deep/60">
              <CardHeader className="pb-3">
                <CardTitle className="text-sm tracking-[0.06em] text-mil-fg">MIRROR OPTIONS</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-3 text-xs text-mil-muted">
                  <div className="flex items-center justify-between gap-3">
                    <span>Source editable mods</span>
                    <span className="font-mono text-brand">{savedEditableModCount}</span>
                  </div>
                  <div className="mt-1 flex items-center justify-between gap-3">
                    <span>Selected targets</span>
                    <span className="font-mono text-brand">{mirrorSelectedTargets.length}</span>
                  </div>
                </div>

                {[
                  ['preserve_system_managed', 'Preserve system-managed mods', 'Keep target dashboard-managed dependencies in place.'],
                  ['include_disabled', 'Include disabled mods', 'Mirror enabled and disabled source entries.'],
                  ['include_pinned_versions', 'Include pinned versions', 'Copy version locks from the source load order.'],
                  ['create_backups', 'Create backups before overwrite', 'Snapshot each target before replacing its load order.'],
                ].map(([key, label, help]) => (
                  <div key={key} className="flex items-start justify-between gap-3 rounded-lg border border-zinc-800 bg-zinc-950/50 p-3">
                    <div>
                      <p className="text-sm text-mil-fg">{label}</p>
                      <p className="mt-1 text-[11px] text-mil-dim">{help}</p>
                    </div>
                    <Switch checked={mirrorOptions[key]} onCheckedChange={(value) => updateMirrorOption(key, value)} className="mt-0.5 h-5 w-9" />
                  </div>
                ))}

                <div className="space-y-2">
                  <label className="text-xs font-medium text-mil-muted">After mirror</label>
                  <select
                    value={mirrorOptions.restart_mode}
                    onChange={(event) => updateMirrorOption('restart_mode', event.target.value)}
                    className="h-9 w-full rounded-md border border-zinc-800 bg-mil-bg-deep/50 px-2 text-xs text-mil-muted"
                  >
                    <option value="none">Do not restart or reconfigure</option>
                    <option value="restart">Restart targets</option>
                    <option value="reconfigure">Reconfigure targets</option>
                  </select>
                </div>

                <Button
                  size="sm"
                  onClick={() => setMirrorConfirmOpen(true)}
                  disabled={!canManage || dirty || mirrorSelectedTargets.length === 0 || mirrorRunning}
                  className="w-full bg-brand text-black hover:bg-brand-light"
                >
                  {mirrorRunning ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Copy className="mr-1 h-3.5 w-3.5" />}
                  Mirror to selected servers
                </Button>
              </CardContent>
            </Card>
          </div>
          )}
        </TabsContent>

        <TabsContent value="batch" className="space-y-4">
          <div className="grid gap-4 xl:grid-cols-2">
            <Card className="border-zinc-800 bg-mil-bg-deep/60">
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-sm tracking-[0.06em] text-mil-fg">
                  <Upload className="h-4 w-4 text-brand" /> IMPORT JSON
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex gap-2">
                  <Button size="sm" variant="outline" onClick={() => fileInputRef.current?.click()} className="h-8 border-zinc-700 text-xs text-mil-muted hover:bg-zinc-900 hover:text-white">
                    <FileUp className="mr-1 h-3.5 w-3.5" />
                    Upload .json file
                  </Button>
                  <input ref={fileInputRef} type="file" accept=".json,application/json" className="hidden" onChange={handleFileImport} />
                  <span className="self-center text-[11px] text-mil-dim">or paste JSON below</span>
                </div>
                <Textarea
                  value={importPayload}
                  onChange={(event) => setImportPayload(event.target.value)}
                  placeholder='Paste a JSON array of mods, a {"mods": [...]} object, or a full Reforger server config.json'
                  rows={12}
                  className="border-zinc-800 bg-mil-bg-deep/50 font-mono text-xs text-white"
                />
                {importError && <p className="text-xs text-red-400">{importError}</p>}
                <Button size="sm" onClick={importMods} disabled={!importPayload.trim() || importing} className="bg-brand text-black hover:bg-brand-light">
                  {importing ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Upload className="mr-1 h-3.5 w-3.5" />}
                  Replace server mod list
                </Button>
              </CardContent>
            </Card>

            <Card className="border-zinc-800 bg-mil-bg-deep/60">
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-sm tracking-[0.06em] text-mil-fg">
                  <FileJson className="h-4 w-4 text-brand" /> EXPORT + REUSE
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Button size="sm" onClick={exportMods} disabled={exporting} className="bg-brand text-black hover:bg-brand-light">
                    {exporting ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Download className="mr-1 h-3.5 w-3.5" />}
                    Refresh export
                  </Button>
                  <select
                    value={exportMode}
                    onChange={(e) => setExportMode(e.target.value)}
                    className="h-8 rounded-md border border-zinc-800 bg-mil-bg-deep/50 px-2 text-xs text-mil-muted"
                  >
                    <option value="mods">Mods only</option>
                    <option value="config">Full server config.json</option>
                  </select>
                  {exportPayload && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-8 border-zinc-700 text-xs text-mil-muted hover:bg-zinc-900 hover:text-white"
                      onClick={() => {
                        const blob = new Blob([exportPayload], { type: 'application/json' });
                        const url = URL.createObjectURL(blob);
                        const a = document.createElement('a');
                        a.href = url;
                        a.download = exportMode === 'config' ? 'server-config.json' : 'mods-export.json';
                        a.click();
                        URL.revokeObjectURL(url);
                      }}
                    >
                      <FileJson className="mr-1 h-3.5 w-3.5" />
                      Download .json
                    </Button>
                  )}
                </div>
                <Textarea
                  value={exportPayload}
                  onChange={(event) => setExportPayload(event.target.value)}
                  placeholder="Exported mod payload will appear here"
                  rows={12}
                  className="border-zinc-800 bg-mil-bg-deep/50 font-mono text-xs text-white"
                />
              </CardContent>
            </Card>
          </div>
        </TabsContent>
      </Tabs>

      <ModDetailPanel
        open={detailOpen}
        onOpenChange={setDetailOpen}
        mod={selectedMod}
        serverId={serverId}
        enabledModIds={new Set([...systemManagedMods, ...enabledMods].map((m) => m.mod_id))}
        savedEnabledModIds={new Set((server?.mods || []).map((m) => m.mod_id || m.modId).filter(Boolean))}
        activeScenarioId={server?.config?.game?.scenarioId || server?.config?.scenarioId || ''}
        sharedScenarioIds={new Set(sharedScenarios.map((scenario) => scenario.id))}
        pinnedVersion={enabledMods.find((m) => m.mod_id === selectedMod?.mod_id)?.version || ''}
        onAddMod={(m) => addMod(m)}
        onAddDependency={(dep) => addMod({ mod_id: dep.mod_id, name: dep.name || dep.mod_id, enabled: true })}
        onResolveAll={() => { setDetailOpen(false); if (selectedMod) handleResolveDepsForExisting(selectedMod); }}
        onPinVersion={handlePinVersion}
        onAddScenarioToLibrary={async (scenario) => {
          try {
            const res = await apiClient.post('/servers/scenarios/library', {
              scenario_id: scenario?.scenario_id,
              name: scenario?.name || scenario?.scenario_id || '',
              mod_id: selectedMod?.mod_id || selectedMod?.modId || '',
              mod_name: selectedMod?.name || '',
              description: scenario?.description || '',
              game_mode: scenario?.game_mode || '',
              player_count: scenario?.player_count || 0,
              thumbnail_url: scenario?.thumbnail_url || '',
            });
            await fetchSharedScenarios();
            if (bumpScenarioRefresh) bumpScenarioRefresh();
            toast({
              title: res.data?.created ? 'Scenario added to shared list' : 'Scenario already in shared list',
              description: scenario?.name || scenario?.scenario_id || 'The scenario library was updated.',
            });
          } catch (error) {
            toast({
              title: 'Unable to add scenario to shared list',
              description: formatApiError(error, 'The scenario library could not be updated.'),
            });
            throw error;
          }
        }}
        onAddScenarioToJson={async (scenarioId) => {
          try {
            const selectedModId = selectedMod?.mod_id || selectedMod?.modId || '';
            const savedModIds = new Set((server?.mods || []).map((mod) => mod.mod_id || mod.modId).filter(Boolean));
            if (selectedModId && !savedModIds.has(selectedModId)) {
              throw new Error('Save the mod load order first so this scenario has its required mod on the server.');
            }
            await apiClient.put(`/servers/${serverId}/scenario`, {
              scenario_id: scenarioId,
            }, {
              validateStatus: (status) => status < 400,
            });
            if (fetchServer) await fetchServer(true);
            toast({
              title: 'Scenario saved to mission JSON',
              description: scenarioId,
            });
          } catch (error) {
            toast({
              title: 'Unable to save scenario to mission JSON',
              description: formatApiError(error, error.message || 'The active scenario could not be updated.'),
            });
            throw error;
          }
        }}
      />

      <Dialog open={mirrorConfirmOpen} onOpenChange={setMirrorConfirmOpen}>
        <DialogContent className="w-[95vw] max-w-lg border-amber-500/30 bg-zinc-950 text-white">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-brand">
              <Copy className="h-5 w-5" />
              Confirm Loadout Mirror
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-100">
              The selected target server load order will be replaced to match the saved load order on <span className="font-semibold text-white">{server?.name || serverId}</span>.
              System-managed dashboard mods are preserved by default, and target-only editable mods will be removed in replace mode.
            </div>
            <div className="max-h-44 space-y-2 overflow-auto rounded-lg border border-zinc-800 bg-mil-bg-deep/60 p-3">
              {selectedMirrorServers.map((target) => (
                <div key={target.id} className="flex items-center justify-between gap-3 text-xs">
                  <span className="truncate text-mil-fg">{target.name || target.id}</span>
                  <span className="shrink-0 text-mil-dim">{Array.isArray(target.mods) ? target.mods.length : 0} current mods</span>
                </div>
              ))}
            </div>
            <div className="grid gap-1.5 text-xs text-mil-muted">
              <div>Preserve system-managed mods: <span className="text-white">{mirrorOptions.preserve_system_managed ? 'Yes' : 'No'}</span></div>
              <div>Include disabled mods: <span className="text-white">{mirrorOptions.include_disabled ? 'Yes' : 'No'}</span></div>
              <div>Include pinned versions: <span className="text-white">{mirrorOptions.include_pinned_versions ? 'Yes' : 'No'}</span></div>
              <div>Create backups: <span className="text-white">{mirrorOptions.create_backups ? 'Yes' : 'No'}</span></div>
              <div>After mirror: <span className="text-white">{mirrorOptions.restart_mode === 'none' ? 'No restart/reconfigure' : mirrorOptions.restart_mode}</span></div>
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => setMirrorConfirmOpen(false)} disabled={mirrorRunning} className="border-zinc-700 text-mil-muted">
                Cancel
              </Button>
              <Button size="sm" onClick={executeMirror} disabled={mirrorRunning || dirty} className="bg-brand text-black hover:bg-brand-light">
                {mirrorRunning ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Copy className="mr-1 h-3.5 w-3.5" />}
                Replace target load orders
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Dependency Resolution Dialog */}
      <Dialog open={historyOpen} onOpenChange={(open) => { if (!open) setHistoryOpen(false); }}>
        <DialogContent className="flex max-h-[88dvh] w-[95vw] max-w-2xl flex-col border-zinc-800 bg-zinc-950 text-white">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-brand">
              <History className="h-5 w-5" />
              Mod Loadout History
            </DialogTitle>
          </DialogHeader>

          <ModRevisionHistory
            serverId={serverId}
            serverName={server?.name}
            canManage={canManage}
            user={user}
            onReverted={handleReverted}
          />
        </DialogContent>
      </Dialog>

      <Dialog open={resolveAllOpen} onOpenChange={(open) => { if (!open) { setResolveAllOpen(false); } }}>
        <DialogContent className="flex max-h-[88dvh] w-[95vw] max-w-2xl flex-col border-zinc-800 bg-zinc-950 text-white">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-brand">
              <GitBranch className="h-5 w-5" />
              Resolve Loadout Dependencies
            </DialogTitle>
          </DialogHeader>

          {resolveAllLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-6 w-6 animate-spin text-brand" />
              <span className="ml-3 text-sm text-mil-muted">Scanning every mod's dependency tree…</span>
            </div>
          ) : resolveAllData?.error ? (
            <div className="flex flex-col items-center justify-center py-10 text-center">
              <AlertTriangle className="mb-2 h-7 w-7 text-amber-400/80" />
              <p className="text-sm text-mil-fg">The dependency scan did not complete.</p>
              <p className="mt-1 max-w-sm text-xs text-mil-dim">{resolveAllData.message}</p>
              <Button
                size="sm"
                variant="outline"
                onClick={resolveAllDependencies}
                className="mt-4 border-zinc-700 text-mil-fg"
              >
                <RefreshCw className="mr-1 h-3.5 w-3.5" />
                Run scan again
              </Button>
            </div>
          ) : resolveAllData ? (
            <Tabs value={resolveAllTab} onValueChange={setResolveAllTab} className="flex min-h-0 flex-1 flex-col">
              <TabsList className="grid w-full grid-cols-2 bg-mil-bg-deep/60">
                <TabsTrigger value="additions" className="text-xs data-[state=active]:bg-brand data-[state=active]:text-black">
                  Additions {resolveAllData.addition_count > 0 ? `(${resolveAllData.addition_count})` : ''}
                </TabsTrigger>
                <TabsTrigger value="tree" className="text-xs data-[state=active]:bg-brand data-[state=active]:text-black">
                  Provider Tree {resolveAllData.provider_count > 0 ? `(${resolveAllData.provider_count})` : ''}
                </TabsTrigger>
              </TabsList>

              {resolveAllData.partial && (
                <div className="mt-3 flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 p-2.5">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-400" />
                  <p className="text-[11px] leading-relaxed text-amber-200/90">
                    Partial results — {resolveAllData.unresolved_count} mod
                    {resolveAllData.unresolved_count === 1 ? '' : 's'} could not be
                    read in time and {resolveAllData.stale_count
                      ? `${resolveAllData.stale_count} more are being re-indexed`
                      : 'are being re-indexed'} now. Run the scan again in a moment
                    to see the rest.
                  </p>
                </div>
              )}

              <TabsContent value="additions" className="mt-3 min-h-0 flex-1 overflow-y-auto">
                {resolveAllData.addition_count === 0 ? (
                  <div className="flex flex-col items-center justify-center py-10 text-center text-mil-dim">
                    <CheckCircle className="mb-2 h-7 w-7 text-emerald-500/70" />
                    <p className="text-sm">Every dependency is already in your saved loadout.</p>
                  </div>
                ) : (
                  <div className="space-y-2">
                    <p className="text-xs text-mil-muted">
                      These mods are pulled in at runtime as dependencies but are missing from your saved config. Adding them makes them explicit, version-pinnable, and trackable.
                    </p>
                    {resolveAllData.additions.map((dep) => (
                      <div key={dep.mod_id} className="flex items-center gap-3 rounded-lg border border-zinc-800/70 bg-mil-bg-deep/40 p-2.5">
                        {dep.thumbnail_url ? (
                          <img src={dep.thumbnail_url} alt="" loading="lazy" className="h-9 w-9 shrink-0 rounded-lg border border-zinc-800 object-cover" />
                        ) : (
                          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-zinc-800 bg-zinc-900">
                            <Puzzle className="h-4 w-4 text-mil-dim" />
                          </div>
                        )}
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm text-mil-fg">{dep.name}</div>
                          <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
                            <span className="font-mono text-[11px] text-mil-dim">{dep.mod_id}</span>
                            {dep.version && (
                              <Badge variant="outline" className="border-blue-600/30 text-[11px] text-blue-300">v{dep.version}</Badge>
                            )}
                            {dep.required_version && dep.required_version !== dep.version && (
                              <Badge variant="outline" className="border-zinc-600/40 text-[11px] text-mil-muted" title="Version the requiring mod was built against">
                                requires v{dep.required_version}
                              </Badge>
                            )}
                            {(dep.dependency_of_names || []).map((parentName) => (
                              <Badge key={parentName} variant="outline" className="border-cyan-500/30 text-[11px] text-cyan-300">
                                Dependency of: {parentName}
                              </Badge>
                            ))}
                            {!dep.metadata_available && (
                              <Badge variant="outline" className="border-amber-500/30 text-[11px] text-amber-300">No metadata</Badge>
                            )}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </TabsContent>

              <TabsContent value="tree" className="mt-3 min-h-0 flex-1 overflow-y-auto">
                {resolveAllData.provider_count === 0 ? (
                  <div className="flex flex-col items-center justify-center py-10 text-center text-mil-dim">
                    <GitBranch className="mb-2 h-7 w-7 text-mil-dim" />
                    <p className="text-sm">No mods in this loadout declare dependencies.</p>
                  </div>
                ) : (
                  <div className="space-y-3">
                    {resolveAllData.tree.map((node, idx) => (
                      <div key={`${node.mod_id}-${idx}`} className="rounded-lg border border-zinc-800/70 bg-mil-bg-deep/40 p-3">
                        <DepTreeNode node={node} />
                      </div>
                    ))}
                  </div>
                )}
              </TabsContent>

              <div className="mt-3 flex shrink-0 items-center justify-end gap-2 border-t border-zinc-800 pt-3">
                <Button size="sm" variant="ghost" onClick={() => setResolveAllOpen(false)} className="text-mil-dim hover:text-white">
                  Close
                </Button>
                <Button
                  size="sm"
                  onClick={addAllResolvedDeps}
                  disabled={!canManage || (resolveAllData.addition_count || 0) === 0}
                  className="bg-brand text-black hover:bg-brand-light"
                >
                  <Plus className="mr-1 h-3.5 w-3.5" />
                  {resolveAllData.addition_count > 0
                    ? `Add ${resolveAllData.addition_count} dependenc${resolveAllData.addition_count === 1 ? 'y' : 'ies'}`
                    : 'Nothing to add'}
                </Button>
              </div>
            </Tabs>
          ) : (
            <p className="py-6 text-sm text-mil-dim">No dependency data available.</p>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={depDialogOpen} onOpenChange={(open) => { if (!open) { setDepDialogOpen(false); setDepResolved(null); setDepSourceMod(null); } }}>
        <DialogContent className="w-[95vw] max-w-lg border-zinc-800 bg-zinc-950 text-white">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-brand">
              <GitBranch className="h-5 w-5" />
              Dependency Resolution
            </DialogTitle>
          </DialogHeader>
          {depLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-brand" />
              <span className="ml-3 text-sm text-mil-muted">Resolving dependency tree…</span>
            </div>
          ) : depResolved ? (
            <div className="space-y-4">
              <p className="text-sm text-mil-muted">
                <span className="font-medium text-white">{depSourceMod?.name || depSourceMod?.mod_id}</span>
                {depResolved.new_count > 0
                  ? ` requires ${depResolved.new_count} additional mod${depResolved.new_count > 1 ? 's' : ''} not yet in your config.`
                  : ' — all dependencies are already in your config.'}
              </p>

              {depResolved.partial && (
                <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 p-2.5">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-400" />
                  <p className="text-[11px] leading-relaxed text-amber-200/90">
                    Partial results — {depResolved.unresolved_count} entr
                    {depResolved.unresolved_count === 1 ? 'y' : 'ies'} could not be
                    read in time and are being re-indexed. Resolve again in a moment
                    to see the full tree.
                  </p>
                </div>
              )}

              {depResolved.resolved?.length > 0 && (
                <div className="max-h-64 space-y-1.5 overflow-y-auto rounded-lg border border-zinc-800 bg-mil-bg-deep/40 p-3">
                  {depResolved.resolved.map((dep, idx) => {
                    const isRoot = dep.mod_id === depResolved.mod_id;
                    const hasRealName = dep.name && dep.name !== dep.mod_id;
                    return (
                      <div key={dep.mod_id || idx} className={`flex items-center gap-2 rounded-lg px-2 py-1.5 ${isRoot ? 'bg-brand/5 border border-brand/20' : ''}`}>
                        <span className="min-w-0 flex-1 text-sm">
                          {hasRealName ? (
                            <>
                              <span className={isRoot ? 'font-medium text-brand' : 'text-mil-fg'}>{dep.name}</span>
                              <span className="ml-2 font-mono text-[11px] text-mil-dim">{dep.mod_id}</span>
                            </>
                          ) : (
                            <span className={`font-mono text-xs ${isRoot ? 'font-medium text-brand' : 'text-mil-fg'}`}>{dep.mod_id}</span>
                          )}
                        </span>
                        {dep.already_present ? (
                          <Badge variant="outline" className="border-emerald-600/30 text-[11px] text-emerald-300">Already in config</Badge>
                        ) : isRoot ? (
                          <Badge variant="outline" className="border-brand/30 text-[11px] text-brand">Target mod</Badge>
                        ) : (
                          <Badge variant="outline" className="border-blue-600/30 text-[11px] text-blue-300">Will be added</Badge>
                        )}
                        {dep.metadata_available === false && (
                          <Badge variant="outline" className="border-amber-500/30 text-[11px] text-amber-300" title="Workshop metadata could not be read — re-run the resolve to retry">
                            No metadata
                          </Badge>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}

              <p className="text-[11px] text-mil-dim">
                Dependencies will be placed before the mod in the load order to ensure correct initialization.
              </p>

              <div className="flex gap-2">
                <Button
                  size="sm"
                  onClick={() => addModWithDependencies(depResolved)}
                  disabled={depResolved.new_count === 0 && [...systemManagedMods, ...enabledMods].some((m) => m.mod_id === depResolved.mod_id)}
                  className="bg-brand text-black hover:bg-brand-light"
                >
                  <GitBranch className="mr-1 h-3.5 w-3.5" />
                  {depResolved.new_count > 0
                    ? `Add ${depResolved.new_count + 1} mod${depResolved.new_count > 0 ? 's' : ''} (deps + mod)`
                    : 'Add mod only'}
                </Button>
                {depResolved.new_count > 0 && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => { addModDirect(depSourceMod); setDepDialogOpen(false); setDepResolved(null); setDepSourceMod(null); }}
                    className="border-zinc-700 text-mil-muted hover:bg-zinc-900 hover:text-white"
                  >
                    Skip dependencies
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => { setDepDialogOpen(false); setDepResolved(null); setDepSourceMod(null); }}
                  className="text-mil-dim hover:text-white"
                >
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <p className="py-4 text-sm text-mil-dim">No dependency data available for this mod.</p>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

export default ModsModule;
