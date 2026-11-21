import React, { useEffect, useState, useCallback, useMemo } from 'react';
import apiClient from '@/lib/apiClient';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import MeasuredChartContainer from '@/components/charts/MeasuredChartContainer';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  AlertTriangle,
  Bell,
  Bot,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Clock,
  Eye,
  Loader2,
  Monitor,
  Package,
  RefreshCw,
  Search,
  Server,
  Sparkles,
  TrendingUp,
  X,
} from 'lucide-react';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from 'recharts';
import {
  severityBadge,
  categoryBadge,
  confidenceColor,
  modSeverityColor,
  statusColor,
  attributionTone,
  actionabilityTone,
  areaTone,
  sourceTone,
  fmtDate,
  humanizeToken,
  VERDICT_OPTIONS,
  ACTIONABILITY_OPTIONS,
  ATTRIBUTION_OPTIONS,
  AREA_OPTIONS,
} from './diagnosticsHelpers';
import { formatApiError } from '@/utils/errorMessages';
import useConfirmDialog from '@/hooks/useConfirmDialog';
import { CommandEmptyState, CommandLoadingState } from '@/components/tactical/CommandUI';

// GET /log-monitor/alerts and /servers/mod-issues return at most this many rows.
const LIST_CAP = 200;


const TABS = [
  { id: 'ai-overview', label: 'AI Overview', icon: Sparkles },
  { id: 'live-errors', label: 'Live Errors', icon: AlertTriangle },
  { id: 'error-patterns', label: 'Error Patterns', icon: Monitor },
  { id: 'mod-analysis', label: 'Mod Analysis', icon: Package },
  { id: 'troublesome-mods', label: 'Troublesome Mods', icon: TrendingUp },
  { id: 'alerts', label: 'Alerts & Incidents', icon: Bell },
];

/* ── main component ─────────────────────────────────────────────────── */

function ServerDiagnostics() {
  /* ── state: log monitor data ───────────────────────────────────── */
  const [servers, setServers] = useState([]);
  const [occurrences, setOccurrences] = useState([]);
  const [errorTypes, setErrorTypes] = useState([]);
  const [alerts, setAlerts] = useState([]);
  // Full counts behind the capped lists (X-Total-Count); null when unknown.
  const [alertTotal, setAlertTotal] = useState(null);
  const [modIssueTotal, setModIssueTotal] = useState(null);
  const [bulkResolving, setBulkResolving] = useState('');
  const { confirm, dialog: confirmDialog } = useConfirmDialog();
  const [stats, setStats] = useState([]);
  const [knownMods, setKnownMods] = useState([]);
  const [troublesomeMods, setTroublesomeMods] = useState([]);

  /* ── state: mod issues data ────────────────────────────────────── */
  const [modIssues, setModIssues] = useState([]);

  /* ── state: UI ─────────────────────────────────────────────────── */
  const [loading, setLoading] = useState(true);
  const [modLoading, setModLoading] = useState(true);
  const [troublesomeLoading, setTroublesomeLoading] = useState(true);
  const [error, setError] = useState('');
  const [activeTab, setActiveTab] = useState('ai-overview');

  /* ── state: occurrence filters ─────────────────────────────────── */
  const [serverFilter, setServerFilter] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [severityFilter, setSeverityFilter] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [reviewStatusFilter, setReviewStatusFilter] = useState('');
  const [attributionFilter, setAttributionFilter] = useState('');
  const [areaFilter, setAreaFilter] = useState('');
  const [actionabilityFilter, setActionabilityFilter] = useState('');
  const [troublesomeOnly, setTroublesomeOnly] = useState(false);
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [totalCount, setTotalCount] = useState(0);

  /* ── state: mod analysis filters ───────────────────────────────── */
  const [modSearch, setModSearch] = useState('');
  const [modStatusFilter, setModStatusFilter] = useState('');
  const [patternSearch, setPatternSearch] = useState('');

  /* ── state: error type detail dialog ───────────────────────────── */
  const [selectedErrorType, setSelectedErrorType] = useState(null);
  const [typeOccurrences, setTypeOccurrences] = useState([]);
  const [typeOccLoading, setTypeOccLoading] = useState(false);
  const [typeSaving, setTypeSaving] = useState(false);
  const [typeReviewStatus, setTypeReviewStatus] = useState('active');
  const [typeAttribution, setTypeAttribution] = useState('unknown');
  const [typeArea, setTypeArea] = useState('error-patterns');
  const [typeActionability, setTypeActionability] = useState('monitor');
  const [typeLinkedModGuid, setTypeLinkedModGuid] = useState('');
  const [typeLinkedModName, setTypeLinkedModName] = useState('');
  const [typeTroublesome, setTypeTroublesome] = useState(false);
  const [typeSuppressCollection, setTypeSuppressCollection] = useState(false);
  const [typeNotes, setTypeNotes] = useState('');

  /* ── state: AI analysis ────────────────────────────────────────── */
  const [aiAnalysis, setAiAnalysis] = useState(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState('');
  const [showRawMessage, setShowRawMessage] = useState(false);
  const [showOccurrences, setShowOccurrences] = useState(false);

  /* ── state: AI triage overview ──────────────────────────────────── */
  const [triageRunning, setTriageRunning] = useState(false);
  const [triageResult, setTriageResult] = useState(null);
  const [contextModal, setContextModal] = useState(null);
  const [contextLoading, setContextLoading] = useState(false);

  /* ── state: mod issue detail dialog ────────────────────────────── */
  const [selectedIssue, setSelectedIssue] = useState(null);
  const [resolutionNotes, setResolutionNotes] = useState('');
  const [issueArea, setIssueArea] = useState('mod-analysis');
  const [issueAttribution, setIssueAttribution] = useState('mod');
  const [issueTroublesome, setIssueTroublesome] = useState(false);
  const [issueTroublesomeReason, setIssueTroublesomeReason] = useState('');

  /* ── data fetching ─────────────────────────────────────────────── */

  const fetchServers = useCallback(async () => {
    try {
      const res = await apiClient.get('/log-monitor/servers');
      setServers(Array.isArray(res.data) ? res.data : []);
    } catch { /* ignore */ }
  }, []);

  const fetchKnownMods = useCallback(async () => {
    try {
      const res = await apiClient.get('/log-monitor/mods');
      setKnownMods(Array.isArray(res.data) ? res.data : []);
    } catch { /* ignore */ }
  }, []);

  const fetchTroublesomeMods = useCallback(async () => {
    setTroublesomeLoading(true);
    try {
      const res = await apiClient.get('/diagnostics/troublesome-mods');
      setTroublesomeMods(Array.isArray(res.data) ? res.data : []);
    } catch {
      setTroublesomeMods([]);
    } finally {
      setTroublesomeLoading(false);
    }
  }, []);

  const fetchOccurrences = useCallback(async () => {
    setLoading(true);
    try {
      setError('');
      const params = new URLSearchParams();
      if (serverFilter) params.set('server', serverFilter);
      if (searchQuery) params.set('q', searchQuery);
      if (severityFilter) params.set('severity', severityFilter);
      if (categoryFilter) params.set('category', categoryFilter);
      if (reviewStatusFilter) params.set('review_status', reviewStatusFilter);
      if (attributionFilter) params.set('attribution_type', attributionFilter);
      if (areaFilter) params.set('designated_area', areaFilter);
      if (actionabilityFilter) params.set('actionability', actionabilityFilter);
      if (troublesomeOnly) params.set('troublesome', 'true');
      if (dateFrom) params.set('from', dateFrom);
      if (dateTo) params.set('to', dateTo);
      params.set('page', page);
      params.set('per_page', 50);

      const res = await apiClient.get(`/log-monitor/errors?${params}`);
      setOccurrences(res.data.items || []);
      setTotalPages(res.data.pages || 1);
      setTotalCount(res.data.total || 0);
    } catch (err) {
      setError(formatApiError(err, 'Failed to load log errors.'));
    } finally {
      setLoading(false);
    }
  }, [serverFilter, searchQuery, severityFilter, categoryFilter, reviewStatusFilter, attributionFilter, areaFilter, actionabilityFilter, troublesomeOnly, dateFrom, dateTo, page]);

  const fetchErrorTypes = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (patternSearch) params.set('q', patternSearch);
      if (severityFilter) params.set('severity', severityFilter);
      if (categoryFilter) params.set('category', categoryFilter);
      if (reviewStatusFilter) params.set('review_status', reviewStatusFilter);
      if (attributionFilter) params.set('attribution_type', attributionFilter);
      if (areaFilter) params.set('designated_area', areaFilter);
      if (actionabilityFilter) params.set('actionability', actionabilityFilter);
      if (troublesomeOnly) params.set('troublesome', 'true');
      const query = params.toString();
      const res = await apiClient.get(`/log-monitor/error-types${query ? `?${query}` : ''}`);
      setErrorTypes(Array.isArray(res.data) ? res.data : []);
    } catch { /* ignore */ }
  }, [patternSearch, severityFilter, categoryFilter, reviewStatusFilter, attributionFilter, areaFilter, actionabilityFilter, troublesomeOnly]);

  const fetchAlerts = useCallback(async () => {
    try {
      const res = await apiClient.get('/log-monitor/alerts?resolved=false');
      setAlerts(Array.isArray(res.data) ? res.data : []);
      const total = Number(res.headers?.['x-total-count']);
      setAlertTotal(Number.isFinite(total) ? total : null);
    } catch { /* ignore */ }
  }, []);

  const fetchStats = useCallback(async () => {
    try {
      const params = serverFilter ? `?server=${serverFilter}` : '';
      const res = await apiClient.get(`/log-monitor/stats${params}`);
      setStats(Array.isArray(res.data) ? res.data : []);
    } catch { /* ignore */ }
  }, [serverFilter]);

  const fetchModIssues = useCallback(async () => {
    setModLoading(true);
    try {
      const params = new URLSearchParams();
      if (modStatusFilter) params.set('status', modStatusFilter);
      if (troublesomeOnly) params.set('troublesome', 'true');
      if (areaFilter) params.set('area', areaFilter);
      const query = params.toString();
      const res = await apiClient.get(`/servers/mod-issues${query ? `?${query}` : ''}`);
      setModIssues(Array.isArray(res.data) ? res.data : []);
      const total = Number(res.headers?.['x-total-count']);
      // The header counts every match; only use it when it is about the same
      // (status) filter the KPI reports.
      setModIssueTotal(Number.isFinite(total) && modStatusFilter === 'active' ? total : null);
    } catch { /* ignore */ }
    finally { setModLoading(false); }
  }, [modStatusFilter, troublesomeOnly, areaFilter]);

  const fetchAll = useCallback(() => {
    fetchServers();
    fetchKnownMods();
    fetchOccurrences();
    fetchErrorTypes();
    fetchAlerts();
    fetchStats();
    fetchModIssues();
    fetchTroublesomeMods();
  }, [fetchServers, fetchKnownMods, fetchOccurrences, fetchErrorTypes, fetchAlerts, fetchStats, fetchModIssues, fetchTroublesomeMods]);

  useEffect(() => { fetchServers(); fetchKnownMods(); fetchAlerts(); }, [fetchServers, fetchKnownMods, fetchAlerts]);
  useEffect(() => { fetchOccurrences(); }, [fetchOccurrences]);
  useEffect(() => { fetchErrorTypes(); }, [fetchErrorTypes]);
  useEffect(() => { fetchStats(); }, [fetchStats]);
  useEffect(() => { fetchModIssues(); }, [fetchModIssues]);
  useEffect(() => { fetchTroublesomeMods(); }, [fetchTroublesomeMods]);

  /* ── error type detail ─────────────────────────────────────────── */

  const openErrorTypeDetail = useCallback(async (et) => {
    setSelectedErrorType(et);
    setAiAnalysis(null);
    setAiError('');
    setShowRawMessage(false);
    setShowOccurrences(false);
    setTypeOccLoading(true);
    try {
      const res = await apiClient.get(`/log-monitor/errors?type=${et.id}&per_page=20`);
      setTypeOccurrences(res.data.items || []);
    } catch { setTypeOccurrences([]); }
    finally { setTypeOccLoading(false); }
  }, []);

  const runAiAnalysis = useCallback(async () => {
    if (!selectedErrorType?.id) return;
    setAiLoading(true);
    setAiError('');
    try {
      const res = await apiClient.post('/diagnostics/ai-analyze', {
        error_type_id: selectedErrorType.id,
      });
      setAiAnalysis(res.data.analysis || null);
    } catch (err) {
      setAiError(formatApiError(err, 'AI analysis failed. Please try again.'));
    } finally {
      setAiLoading(false);
    }
  }, [selectedErrorType?.id]);

  const runBatchTriage = useCallback(async () => {
    setTriageRunning(true);
    setTriageResult(null);
    try {
      const res = await apiClient.post('/diagnostics/ai-triage');
      setTriageResult(res.data);
      // Refresh error types to pick up new AI classifications
      fetchErrorTypes();
    } catch (err) {
      setTriageResult({ triaged: 0, failed: 0, errors: [formatApiError(err, 'Triage failed')] });
    } finally {
      setTriageRunning(false);
    }
  }, [fetchErrorTypes]);

  const fetchOccurrenceContext = useCallback(async (occId) => {
    setContextLoading(true);
    try {
      const res = await apiClient.get(`/log-monitor/errors/${occId}/context`);
      setContextModal(res.data);
    } catch {
      setContextModal(null);
    } finally {
      setContextLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!selectedErrorType) return;
    setTypeReviewStatus(selectedErrorType.review_status || 'active');
    setTypeAttribution(selectedErrorType.attribution_type || 'unknown');
    setTypeArea(selectedErrorType.designated_area || 'error-patterns');
    setTypeActionability(selectedErrorType.actionability || 'monitor');
    setTypeLinkedModGuid(selectedErrorType.linked_mod_guid || '');
    setTypeLinkedModName(selectedErrorType.linked_mod_name || '');
    setTypeTroublesome(Boolean(selectedErrorType.troublesome));
    setTypeSuppressCollection(Boolean(selectedErrorType.suppress_collection));
    setTypeNotes(selectedErrorType.curation_notes || '');
  }, [selectedErrorType]);

  /* ── alert resolve ─────────────────────────────────────────────── */

  const resolveAlert = useCallback(async (alertId) => {
    try {
      await apiClient.patch(`/log-monitor/alerts/${alertId}`);
      fetchAlerts();
    } catch (err) {
      setError(formatApiError(err, 'Failed to resolve alert.'));
    }
  }, [fetchAlerts]);

  const resolveAlertsBulk = useCallback(async (scope, count) => {
    const deletedOnly = scope === 'deleted';
    if (!(await confirm({
      title: deletedOnly ? 'Resolve Alerts From Deleted Servers' : 'Resolve All Open Alerts',
      description: deletedOnly
        ? `Resolve ${count.toLocaleString()} open alert${count === 1 ? '' : 's'} raised by servers that no longer exist?`
        : `Resolve all ${count.toLocaleString()} open alert${count === 1 ? '' : 's'} across the fleet? New detections raise new alerts.`,
      confirmLabel: 'Resolve',
    }))) {
      return;
    }
    setBulkResolving(scope);
    try {
      await apiClient.post('/log-monitor/alerts/resolve', { deleted_servers_only: deletedOnly });
      setError('');
      await fetchAlerts();
    } catch (err) {
      setError(formatApiError(err, 'Failed to resolve alerts.'));
    } finally {
      setBulkResolving('');
    }
  }, [confirm, fetchAlerts]);

  /* ── mod issue verdict ─────────────────────────────────────────── */

  const updateIssueStatus = useCallback(async (issueId, status, notes = '', extra = {}) => {
    try {
      await apiClient.post(`/servers/mod-issues/${issueId}/resolve`, {
        status,
        resolution_notes: notes,
        ...extra,
      });
      if (selectedIssue?.id === issueId) {
        setSelectedIssue((current) => current ? { ...current, status, resolution_notes: notes, ...extra } : current);
      }
      await fetchModIssues();
      await fetchTroublesomeMods();
    } catch (err) {
      setError(formatApiError(err, 'Failed to update issue verdict.'));
    }
  }, [fetchModIssues, fetchTroublesomeMods, selectedIssue?.id]);

  const saveIssueCuration = useCallback(async () => {
    if (!selectedIssue?.id) return;
    await updateIssueStatus(selectedIssue.id, selectedIssue.status || 'active', resolutionNotes, {
      designated_area: issueArea,
      attribution_type: issueAttribution,
      troublesome: issueTroublesome,
      troublesome_reason: issueTroublesomeReason,
    });
  }, [selectedIssue, resolutionNotes, issueArea, issueAttribution, issueTroublesome, issueTroublesomeReason, updateIssueStatus]);

  const saveErrorTypeCuration = useCallback(async () => {
    if (!selectedErrorType?.id) return;
    setTypeSaving(true);
    try {
      const payload = {
        review_status: typeReviewStatus,
        attribution_type: typeAttribution,
        designated_area: typeArea,
        actionability: typeActionability,
        linked_mod_guid: typeLinkedModGuid,
        linked_mod_name: typeLinkedModName,
        troublesome: typeTroublesome,
        suppress_collection: typeSuppressCollection,
        curation_notes: typeNotes,
      };
      const res = await apiClient.patch(`/log-monitor/error-types/${selectedErrorType.id}`, payload);
      setSelectedErrorType(res.data);
      await fetchErrorTypes();
      await fetchOccurrences();
      await fetchTroublesomeMods();
    } catch (err) {
      setError(formatApiError(err, 'Failed to save error pattern curation.'));
    } finally {
      setTypeSaving(false);
    }
  }, [selectedErrorType?.id, typeReviewStatus, typeAttribution, typeArea, typeActionability, typeLinkedModGuid, typeLinkedModName, typeTroublesome, typeSuppressCollection, typeNotes, fetchErrorTypes, fetchOccurrences, fetchTroublesomeMods]);

  useEffect(() => {
    if (!selectedIssue) return;
    setResolutionNotes(selectedIssue.resolution_notes || '');
    setIssueArea(selectedIssue.designated_area || 'mod-analysis');
    setIssueAttribution(selectedIssue.attribution_type || 'mod');
    setIssueTroublesome(Boolean(selectedIssue.troublesome));
    setIssueTroublesomeReason(selectedIssue.troublesome_reason || '');
  }, [selectedIssue]);

  /* ── server name lookup ────────────────────────────────────────── */

  const serverMap = useMemo(() => {
    const m = {};
    for (const s of servers) m[s.id] = s.name || s.id;
    return m;
  }, [servers]);

  /* ── summary stats (computed from fetched data) ────────────────── */

  const summaryStats = useMemo(() => {
    const total = totalCount;
    // Counted from the 14-day stats, not the 50 occurrences on the open page
    // of the Live Errors table, which is what this used to sum.
    const criticalCount = stats.reduce((sum, day) => sum + (Number(day.critical) || 0), 0);
    const activeModIssues = modIssueTotal ?? modIssues.filter((i) => i.status === 'active').length;
    const activeAlerts = alertTotal ?? alerts.length;
    const modsWithIssues = new Set(modIssues.map((i) => i.mod_id).filter(Boolean)).size;
    const curatedPatterns = errorTypes.filter((item) => Boolean(item.reviewed_by)).length;
    return { total, criticalCount, activeModIssues, activeAlerts, modsWithIssues, troublesomeMods: troublesomeMods.length, curatedPatterns };
  }, [totalCount, stats, alerts, alertTotal, modIssues, modIssueTotal, troublesomeMods, errorTypes]);

  /* ── AI overview computed data ──────────────────────────────────── */
  const aiTriagedTypes = useMemo(() =>
    errorTypes.filter((et) => et.ai_triaged_at),
  [errorTypes]);

  const aiUntriaged = useMemo(() =>
    errorTypes.filter((et) => !et.ai_triaged_at && !et.reviewed_by),
  [errorTypes]);

  const aiSeverityBreakdown = useMemo(() => {
    const counts = { critical: 0, high: 0, moderate: 0, low: 0, harmless: 0 };
    for (const et of aiTriagedTypes) {
      const sev = et.ai_severity_assessment || 'low';
      if (counts[sev] !== undefined) counts[sev]++;
    }
    return counts;
  }, [aiTriagedTypes]);

  const aiActionableItems = useMemo(() =>
    aiTriagedTypes
      .filter((et) => et.ai_suggested_actionability === 'actionable' && et.ai_severity_assessment !== 'harmless')
      .sort((a, b) => {
        const sevOrder = { critical: 0, high: 1, moderate: 2, low: 3, harmless: 4 };
        return (sevOrder[a.ai_severity_assessment] ?? 5) - (sevOrder[b.ai_severity_assessment] ?? 5);
      }),
  [aiTriagedTypes]);

  const aiSafeToIgnore = useMemo(() =>
    aiTriagedTypes.filter((et) => et.ai_is_safe_to_ignore),
  [aiTriagedTypes]);

  /* ── mod issues client-side search ─────────────────────────────── */

  const filteredModIssues = useMemo(() => modIssues.filter((issue) => {
    if (!modSearch) return true;
    const haystack = [
      issue.mod_name,
      issue.mod_id,
      issue.impact_summary,
      issue.error_pattern,
      issue.error_signature,
      issue.source_category,
      issue.issue_type,
      ...(issue.source_streams || []),
    ].filter(Boolean).join(' ').toLowerCase();
    return haystack.includes(modSearch.toLowerCase());
  }), [modIssues, modSearch]);

  const filteredTroublesomeMods = useMemo(() => troublesomeMods.filter((item) => {
    if (!modSearch) return true;
    const haystack = [
      item.mod_name,
      item.mod_id,
      item.reason,
      ...(item.source_categories || []),
      ...(item.designated_areas || []),
      ...(item.attribution_types || []),
    ].filter(Boolean).join(' ').toLowerCase();
    return haystack.includes(modSearch.toLowerCase());
  }), [troublesomeMods, modSearch]);

  /* ── filter active check ───────────────────────────────────────── */

  const hasActiveFilters = serverFilter || searchQuery || severityFilter || categoryFilter || reviewStatusFilter || attributionFilter || areaFilter || actionabilityFilter || troublesomeOnly || dateFrom || dateTo || patternSearch;

  const clearFilters = useCallback(() => {
    setServerFilter('');
    setSearchQuery('');
    setSeverityFilter('');
    setCategoryFilter('');
    setReviewStatusFilter('');
    setAttributionFilter('');
    setAreaFilter('');
    setActionabilityFilter('');
    setTroublesomeOnly(false);
    setDateFrom('');
    setDateTo('');
    setPatternSearch('');
    setPage(1);
  }, []);

  /* ── render ─────────────────────────────────────────────────────── */

  return (
    <div className="space-y-6">
      {confirmDialog}
      {/* ── Header ────────────────────────────────────────────────── */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="mb-1 text-xs font-medium text-brand">
            Server management
          </div>
          <h1 className="text-2xl font-bold tracking-[0.06em] text-brand-light" style={{ fontFamily: "var(--font-heading)" }}>
            Server Diagnostics
          </h1>
          <p className="mt-1 text-sm text-mil-muted" style={{ fontFamily: "var(--font-body)" }}>
            AI-powered error classification, mod issue analysis, and alerting across all managed Arma Reforger servers.
          </p>
        </div>
        <Button onClick={fetchAll} variant="outline" size="sm" className="border-[rgba(232,131,58,0.15)] text-mil-muted hover:text-white">
          <RefreshCw className="mr-1 h-4 w-4" /> Refresh
        </Button>
      </div>

      {/* ── Summary stat cards ────────────────────────────────────── */}
      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
        {[
          { label: 'Total Errors', value: summaryStats.total, color: 'text-white' },
          { label: 'Critical · 14d', value: summaryStats.criticalCount, color: 'text-red-400' },
          // Both lists come back capped at LIST_CAP rows; a bare "200" read as an exact count.
          { label: 'Active Mod Issues', value: summaryStats.activeModIssues, capped: modIssueTotal === null && modIssues.length >= LIST_CAP, color: 'text-orange-400' },
          { label: 'Active Alerts', value: summaryStats.activeAlerts, capped: alertTotal === null && alerts.length >= LIST_CAP, color: 'text-yellow-400' },
          { label: 'Mods With Issues', value: summaryStats.modsWithIssues, capped: modIssues.length >= LIST_CAP, color: 'text-blue-400' },
          { label: 'Troublesome Mods', value: summaryStats.troublesomeMods, color: 'text-rose-400' },
        ].map(({ label, value, capped, color }) => (
          <Card key={label} className="border-[rgba(232,131,58,0.12)] bg-mil-bg-panel/50">
            <CardContent className="px-4 py-3">
              <p className="text-xs text-mil-muted font-medium capitalize">{label}</p>
              <p className={`text-xl font-bold ${color}`} title={capped ? `At least ${value.toLocaleString()}; the list is capped at ${LIST_CAP}.` : undefined}>
                {value.toLocaleString()}{capped ? '+' : ''}
              </p>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* ── Errors per day chart ──────────────────────────────────── */}
      {stats.length > 0 && (
        <Card className="border-[rgba(232,131,58,0.12)] bg-mil-bg-panel/50">
          <CardContent className="py-4">
            <p className="mb-3 text-xs text-mil-muted font-medium">Errors Per Day</p>
            <MeasuredChartContainer className="h-[200px]" minHeight={80}>
              <ResponsiveContainer width="100%" height="100%" minWidth={0} minHeight={0}>
                <BarChart data={stats}>
                  <XAxis dataKey="date" tick={{ fill: '#7d7d7d', fontSize: 11 }} />
                  <YAxis tick={{ fill: '#7d7d7d', fontSize: 11 }} />
                  <Tooltip
                    contentStyle={{ backgroundColor: '#101010', border: '1px solid rgba(232,131,58,0.15)', color: '#fff', fontSize: 12 }}
                  />
                  <Legend wrapperStyle={{ fontSize: 11, color: '#949494' }} />
                  <Bar dataKey="critical" stackId="a" fill="#ef4444" name="Critical" />
                  <Bar dataKey="high" stackId="a" fill="#f97316" name="High" />
                  <Bar dataKey="medium" stackId="a" fill="#eab308" name="Medium" />
                  <Bar dataKey="low" stackId="a" fill="#3b82f6" name="Low" />
                </BarChart>
              </ResponsiveContainer>
            </MeasuredChartContainer>
          </CardContent>
        </Card>
      )}

      {/* ── Tabs ──────────────────────────────────────────────────── */}
      <div className="flex gap-1 border-b border-[rgba(232,131,58,0.12)]">
        {TABS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => setActiveTab(id)}
            className={`flex items-center gap-1.5 px-4 py-2 text-sm font-medium transition-colors ${
              activeTab === id
                ? 'border-b-2 border-brand-light text-brand-light'
                : 'text-mil-dim hover:text-white'
            }`}
          >
            <Icon className="h-3.5 w-3.5" />
            {label}
          </button>
        ))}
      </div>

      {/* ── Error banner ──────────────────────────────────────────── */}
      {error && (
        <div className="rounded border border-red-700/50 bg-red-900/30 px-4 py-2 text-sm text-red-300">
          {error}
        </div>
      )}

      {/* ═══════════════════════════════════════════════════════════ */}
      {/* Tab 0: AI Overview                                        */}
      {/* ═══════════════════════════════════════════════════════════ */}
      {activeTab === 'ai-overview' && (
        <div className="space-y-6">
          {/* AI status header */}
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="flex items-center gap-2 text-lg font-semibold tracking-wider text-brand-light">
                <Sparkles className="h-5 w-5" /> AI TRIAGE OVERVIEW
              </h2>
              <p className="mt-1 text-sm text-mil-muted">
                Automatic classification of error patterns. AI reviews each error type and recommends severity, actionability, and attribution.
              </p>
            </div>
            <div className="flex items-center gap-2">
              {aiUntriaged.length > 0 && (
                <span className="text-xs text-mil-muted">
                  {aiUntriaged.length} untriaged pattern{aiUntriaged.length !== 1 ? 's' : ''}
                </span>
              )}
              <Button
                onClick={runBatchTriage}
                disabled={triageRunning}
                variant="outline"
                size="sm"
                className="border-[rgba(232,131,58,0.25)] text-brand-light hover:bg-[rgba(232,131,58,0.1)]"
              >
                {triageRunning ? (
                  <><RefreshCw className="mr-1 h-3.5 w-3.5 animate-spin" /> Triaging…</>
                ) : (
                  <><Bot className="mr-1 h-3.5 w-3.5" /> Run AI Triage</>
                )}
              </Button>
            </div>
          </div>

          {/* Triage result banner */}
          {triageResult && (
            <div className={`rounded border px-4 py-2 text-sm ${
              triageResult.errors?.length
                ? 'border-yellow-700/50 bg-yellow-900/20 text-yellow-300'
                : 'border-green-700/50 bg-green-900/20 text-green-300'
            }`}>
              AI triaged <strong>{triageResult.triaged}</strong> error pattern{triageResult.triaged !== 1 ? 's' : ''}.
              {triageResult.failed > 0 && <> <strong>{triageResult.failed}</strong> failed.</>}
              {triageResult.errors?.length > 0 && (
                <span className="ml-2 text-xs text-mil-muted">({triageResult.errors[0]})</span>
              )}
            </div>
          )}

          {/* AI severity summary cards */}
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-3">
            {[
              { label: 'Critical', count: aiSeverityBreakdown.critical, color: 'text-red-400', border: 'border-red-700/30' },
              { label: 'High', count: aiSeverityBreakdown.high, color: 'text-orange-400', border: 'border-orange-700/30' },
              { label: 'Moderate', count: aiSeverityBreakdown.moderate, color: 'text-yellow-400', border: 'border-yellow-700/30' },
              { label: 'Low', count: aiSeverityBreakdown.low, color: 'text-blue-400', border: 'border-blue-700/30' },
              { label: 'Harmless', count: aiSeverityBreakdown.harmless, color: 'text-mil-muted', border: 'border-zinc-700/30' },
            ].map(({ label, count, color, border }) => (
              <Card key={label} className={`${border} bg-mil-bg-panel/50`}>
                <CardContent className="px-4 py-3">
                  <p className="text-xs text-mil-muted font-medium capitalize">AI: {label}</p>
                  <p className={`text-xl font-bold ${color}`}>{count}</p>
                </CardContent>
              </Card>
            ))}
          </div>

          {/* Actionable items — what the admin should actually look at */}
          {aiActionableItems.length > 0 && (
            <Card className="border-red-700/20 bg-mil-bg-panel/60">
              <CardContent className="py-4">
                <h3 className="mb-3 flex items-center gap-2 text-xs font-semibold text-red-400">
                  <AlertTriangle className="h-4 w-4" /> REQUIRES ATTENTION ({aiActionableItems.length})
                </h3>
                <div className="space-y-2">
                  {aiActionableItems.slice(0, 20).map((et) => (
                    <div
                      key={et.id}
                      onClick={() => openErrorTypeDetail(et)}
                      className="cursor-pointer rounded border border-[rgba(232,131,58,0.1)] bg-mil-bg-deep/60 px-4 py-3 transition-colors hover:border-[rgba(232,131,58,0.25)]"
                    >
                      <div className="flex items-start justify-between gap-4">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className={`capitalize inline-block rounded border px-2 py-0.5 text-[11px] ${severityBadge(et.ai_severity_assessment === 'moderate' ? 'medium' : et.ai_severity_assessment)}`}>
                              {et.ai_severity_assessment || et.severity}
                            </span>
                            <span className={`capitalize inline-block rounded border px-2 py-0.5 text-[11px] ${attributionTone(et.ai_suggested_attribution || et.attribution_type)}`}>
                              {humanizeToken(et.ai_suggested_attribution || et.attribution_type || 'unknown')}
                            </span>
                            <span className="text-[11px] text-mil-dim">
                              {et.total_occurrences?.toLocaleString()} occurrence{et.total_occurrences !== 1 ? 's' : ''}
                            </span>
                          </div>
                          <p className="mt-1 text-sm font-medium text-white">{et.label}</p>
                          {et.ai_summary && (
                            <p className="mt-1 text-xs text-mil-muted">
                              <Bot className="mr-1 inline h-3 w-3 text-brand-light" />
                              {et.ai_summary}
                            </p>
                          )}
                        </div>
                        <ChevronRight className="mt-1 h-4 w-4 shrink-0 text-mil-dim" />
                      </div>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}

          {/* Safe to ignore section */}
          {aiSafeToIgnore.length > 0 && (
            <Card className="border-zinc-800 bg-mil-bg-panel/40">
              <CardContent className="py-4">
                <h3 className="mb-3 flex items-center gap-2 text-xs font-semibold text-mil-dim">
                  <CheckCircle2 className="h-4 w-4 text-green-600" /> SAFE TO IGNORE ({aiSafeToIgnore.length})
                </h3>
                <div className="space-y-1.5">
                  {aiSafeToIgnore.slice(0, 15).map((et) => (
                    <div
                      key={et.id}
                      onClick={() => openErrorTypeDetail(et)}
                      className="cursor-pointer rounded border border-zinc-800/50 bg-mil-bg-deep/40 px-3 py-2 text-xs transition-colors hover:border-[rgba(232,131,58,0.15)]"
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <span className="inline-block rounded border border-zinc-700 px-1.5 py-0.5 text-[11px] text-mil-dim capitalize">
                            {et.ai_severity_assessment || et.severity}
                          </span>
                          <span className="text-mil-muted">{et.label}</span>
                        </div>
                        <span className="text-[11px] text-mil-dim">{et.total_occurrences?.toLocaleString()}</span>
                      </div>
                      {et.ai_summary && (
                        <p className="mt-1 text-[11px] text-mil-dim">
                          <Bot className="mr-1 inline h-3 w-3" />{et.ai_summary}
                        </p>
                      )}
                    </div>
                  ))}
                  {aiSafeToIgnore.length > 15 && (
                    <p className="mt-2 text-center text-[11px] text-mil-dim">
                      + {aiSafeToIgnore.length - 15} more safe-to-ignore patterns
                    </p>
                  )}
                </div>
              </CardContent>
            </Card>
          )}

          {/* Full AI-triaged list */}
          {aiTriagedTypes.length > 0 && (
            <Card className="border-[rgba(232,131,58,0.12)] bg-mil-bg-panel/50">
              <CardContent className="py-4">
                <h3 className="mb-3 text-xs font-semibold text-mil-muted">
                  ALL AI-TRIAGED PATTERNS ({aiTriagedTypes.length})
                </h3>
                <div className="overflow-x-auto">
                  <table className="min-w-full text-left text-xs">
                    <thead>
                      <tr className="border-b border-zinc-800 text-[11px] text-mil-dim">
                        <th className="py-2 pr-3 font-medium">Pattern</th>
                        <th className="py-2 pr-3 font-medium">AI Severity</th>
                        <th className="py-2 pr-3 font-medium">AI Action</th>
                        <th className="py-2 pr-3 font-medium">AI Attribution</th>
                        <th className="py-2 pr-3 font-medium">AI Status</th>
                        <th className="py-2 pr-3 font-medium">Occurrences</th>
                        <th className="py-2 pr-0 font-medium">AI Summary</th>
                      </tr>
                    </thead>
                    <tbody>
                      {aiTriagedTypes.slice(0, 50).map((et) => (
                        <tr
                          key={et.id}
                          onClick={() => openErrorTypeDetail(et)}
                          className="cursor-pointer border-b border-zinc-900/60 transition-colors hover:bg-[rgba(232,131,58,0.03)]"
                        >
                          <td className="max-w-[200px] truncate py-2 pr-3 font-medium text-white">{et.label}</td>
                          <td className="py-2 pr-3">
                            <span className={`capitalize inline-block rounded border px-1.5 py-0.5 text-[11px] ${severityBadge(et.ai_severity_assessment === 'moderate' ? 'medium' : et.ai_severity_assessment)}`}>
                              {et.ai_severity_assessment || '—'}
                            </span>
                          </td>
                          <td className="py-2 pr-3">
                            <span className={`capitalize inline-block rounded border px-1.5 py-0.5 text-[11px] ${actionabilityTone(et.ai_suggested_actionability)}`}>
                              {humanizeToken(et.ai_suggested_actionability || '—')}
                            </span>
                          </td>
                          <td className="py-2 pr-3">
                            <span className={`capitalize inline-block rounded border px-1.5 py-0.5 text-[11px] ${attributionTone(et.ai_suggested_attribution)}`}>
                              {humanizeToken(et.ai_suggested_attribution || '—')}
                            </span>
                          </td>
                          <td className="py-2 pr-3">
                            <span className={`capitalize inline-block rounded border px-1.5 py-0.5 text-[11px] ${statusColor(et.ai_suggested_review_status)}`}>
                              {humanizeToken(et.ai_suggested_review_status || '—')}
                            </span>
                          </td>
                          <td className="py-2 pr-3 text-mil-muted">{et.total_occurrences?.toLocaleString()}</td>
                          <td className="max-w-[250px] truncate py-2 pr-0 text-mil-dim">{et.ai_summary || '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Empty state */}
          {aiTriagedTypes.length === 0 && aiUntriaged.length > 0 && (
            <Card className="border-[rgba(232,131,58,0.12)] bg-mil-bg-panel/50">
              <CardContent className="flex flex-col items-center justify-center py-16 text-center">
                <Bot className="mb-3 h-12 w-12 text-mil-dim" />
                <p className="text-sm text-mil-muted">
                  No error patterns have been AI-triaged yet.
                </p>
                <p className="mt-1 text-xs text-mil-dim">
                  Click <strong>Run AI Triage</strong> above to classify {aiUntriaged.length} uncurated pattern{aiUntriaged.length !== 1 ? 's' : ''}.
                </p>
              </CardContent>
            </Card>
          )}

          {aiTriagedTypes.length === 0 && aiUntriaged.length === 0 && errorTypes.length === 0 && (
            <Card className="border-[rgba(232,131,58,0.12)] bg-mil-bg-panel/50">
              <CardContent className="flex flex-col items-center justify-center py-16 text-center">
                <CheckCircle2 className="mb-3 h-12 w-12 text-green-600" />
                <p className="text-sm text-mil-muted">
                  No error patterns detected. Your servers are running clean.
                </p>
              </CardContent>
            </Card>
          )}
        </div>
      )}

      {/* ── Context Viewer Modal ──────────────────────────────────── */}
      {contextModal && (
        <Dialog open onOpenChange={() => setContextModal(null)}>
          <DialogContent className="max-h-[80vh] max-w-3xl overflow-y-auto border-[rgba(232,131,58,0.15)] bg-mil-bg-panel">
            <DialogHeader>
              <DialogTitle className="text-sm font-semibold tracking-wider text-brand-light">
                LOG CONTEXT
              </DialogTitle>
            </DialogHeader>
            <div className="space-y-2 font-mono text-xs">
              {contextModal.context_before?.length > 0 && (
                <div>
                  <p className="mb-1 text-xs text-mil-muted font-medium capitalize">
                    Before ({contextModal.context_before.length} lines)
                  </p>
                  <div className="max-h-[200px] overflow-y-auto rounded border border-zinc-800 bg-mil-bg-deep p-2">
                    {contextModal.context_before.map((line, i) => (
                      <div key={i} className="whitespace-pre-wrap text-mil-muted">{line}</div>
                    ))}
                  </div>
                </div>
              )}
              <div>
                <p className="mb-1 text-xs text-red-400 font-medium">Error line</p>
                <div className="rounded border border-red-700/40 bg-red-900/10 p-2 text-red-300">
                  {contextModal.raw}
                </div>
              </div>
              {contextModal.context_after?.length > 0 && (
                <div>
                  <p className="mb-1 text-xs text-mil-muted font-medium capitalize">
                    After ({contextModal.context_after.length} lines)
                  </p>
                  <div className="max-h-[200px] overflow-y-auto rounded border border-zinc-800 bg-mil-bg-deep p-2">
                    {contextModal.context_after.map((line, i) => (
                      <div key={i} className="whitespace-pre-wrap text-mil-muted">{line}</div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </DialogContent>
        </Dialog>
      )}

      {/* ═══════════════════════════════════════════════════════════ */}
      {/* Tab 1: Live Errors                                        */}
      {/* ═══════════════════════════════════════════════════════════ */}
      {activeTab === 'live-errors' && (
        <>
          {/* Filters */}
          <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap">
            <select
              value={serverFilter}
              onChange={(e) => { setServerFilter(e.target.value); setPage(1); }}
              className="rounded-md border border-[rgba(232,131,58,0.15)] bg-mil-bg-panel px-3 py-2 text-sm text-white"
            >
              <option value="">All Servers</option>
              {servers.map((s) => (
                <option key={s.id} value={s.id}>{s.name || s.id}</option>
              ))}
            </select>

            <select
              value={severityFilter}
              onChange={(e) => { setSeverityFilter(e.target.value); setPage(1); }}
              className="rounded-md border border-[rgba(232,131,58,0.15)] bg-mil-bg-panel px-3 py-2 text-sm text-white"
            >
              <option value="">All Severities</option>
              <option value="critical">Critical</option>
              <option value="high">High</option>
              <option value="medium">Medium</option>
              <option value="low">Low</option>
            </select>

            <select
              value={categoryFilter}
              onChange={(e) => { setCategoryFilter(e.target.value); setPage(1); }}
              className="rounded-md border border-[rgba(232,131,58,0.15)] bg-mil-bg-panel px-3 py-2 text-sm text-white"
            >
              <option value="">All Categories</option>
              <option value="backend-error">Backend Error</option>
              <option value="addon-load">Addon Load</option>
              <option value="fragmentizer">Fragmentizer</option>
              <option value="script-error">Script Error</option>
              <option value="resource-error">Resource Error</option>
              <option value="network-error">Network Error</option>
              <option value="world-error">World/Terrain Error</option>
              <option value="crash">Crash / Fatal</option>
              <option value="null-reference">Null Reference</option>
              <option value="mod-mismatch">Mod Mismatch</option>
              <option value="config-error">Config Error</option>
              <option value="physics-error">Physics Error</option>
              <option value="ai-error">AI Error</option>
              <option value="generic-error">Generic Error</option>
            </select>

            <select
              value={reviewStatusFilter}
              onChange={(e) => { setReviewStatusFilter(e.target.value); setPage(1); }}
              className="rounded-md border border-[rgba(232,131,58,0.15)] bg-mil-bg-panel px-3 py-2 text-sm text-white"
            >
              <option value="">All Reviews</option>
              {VERDICT_OPTIONS.map((status) => (
                <option key={status} value={status}>{humanizeToken(status)}</option>
              ))}
            </select>

            <select
              value={attributionFilter}
              onChange={(e) => { setAttributionFilter(e.target.value); setPage(1); }}
              className="rounded-md border border-[rgba(232,131,58,0.15)] bg-mil-bg-panel px-3 py-2 text-sm text-white"
            >
              <option value="">All Attribution</option>
              {ATTRIBUTION_OPTIONS.map((item) => (
                <option key={item} value={item}>{humanizeToken(item)}</option>
              ))}
            </select>

            <select
              value={areaFilter}
              onChange={(e) => { setAreaFilter(e.target.value); setPage(1); }}
              className="rounded-md border border-[rgba(232,131,58,0.15)] bg-mil-bg-panel px-3 py-2 text-sm text-white"
            >
              <option value="">All Areas</option>
              {AREA_OPTIONS.map((item) => (
                <option key={item} value={item}>{humanizeToken(item)}</option>
              ))}
            </select>

            <select
              value={actionabilityFilter}
              onChange={(e) => { setActionabilityFilter(e.target.value); setPage(1); }}
              className="rounded-md border border-[rgba(232,131,58,0.15)] bg-mil-bg-panel px-3 py-2 text-sm text-white"
            >
              <option value="">All Actionability</option>
              {ACTIONABILITY_OPTIONS.map((item) => (
                <option key={item} value={item}>{humanizeToken(item)}</option>
              ))}
            </select>

            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-mil-dim" />
              <Input
                value={searchQuery}
                onChange={(e) => { setSearchQuery(e.target.value); setPage(1); }}
                placeholder="Search messages..."
                className="border-[rgba(232,131,58,0.15)] bg-mil-bg-panel pl-10 text-white"
              />
            </div>

            <Input
              type="date"
              value={dateFrom}
              onChange={(e) => { setDateFrom(e.target.value); setPage(1); }}
              className="w-full sm:w-36 border-[rgba(232,131,58,0.15)] bg-mil-bg-panel text-white"
              placeholder="From"
            />
            <Input
              type="date"
              value={dateTo}
              onChange={(e) => { setDateTo(e.target.value); setPage(1); }}
              className="w-full sm:w-36 border-[rgba(232,131,58,0.15)] bg-mil-bg-panel text-white"
              placeholder="To"
            />

            <Button
              size="sm"
              variant="outline"
              onClick={() => { setTroublesomeOnly((current) => !current); setPage(1); }}
              className={`border-[rgba(232,131,58,0.15)] ${troublesomeOnly ? 'text-brand' : 'text-mil-muted'} hover:text-white`}
            >
              {troublesomeOnly ? 'Showing Troublesome Only' : 'Show Troublesome Only'}
            </Button>

            {hasActiveFilters && (
              <Button size="sm" variant="ghost" onClick={clearFilters} className="text-mil-dim hover:text-white">
                <X className="mr-1 h-3 w-3" /> Clear
              </Button>
            )}
          </div>

          {/* Occurrences table */}
          {loading ? (
            <div className="space-y-3">
              {[1, 2, 3].map((i) => (
                <div key={i} className="h-16 animate-pulse rounded-lg bg-mil-bg-panel/50" />
              ))}
            </div>
          ) : occurrences.length === 0 ? (
            <Card className="border-[rgba(232,131,58,0.12)] bg-mil-bg-panel/50">
              <CardContent className="flex flex-col items-center justify-center py-16 text-mil-dim">
                <CheckCircle2 className="mb-4 h-12 w-12 opacity-30" />
                <p className="text-lg font-medium">No errors detected</p>
                <p className="mt-1 text-sm">
                  The log monitor will populate this page as errors are detected in server console output.
                </p>
              </CardContent>
            </Card>
          ) : (
            <>
              <div className="overflow-x-auto rounded-lg border border-[rgba(232,131,58,0.12)]">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-[rgba(232,131,58,0.12)] bg-mil-bg-panel/70">
                      <th className="px-3 py-2 text-left text-xs text-mil-dim">Time</th>
                      <th className="px-3 py-2 text-left text-xs text-mil-dim">Server</th>
                      <th className="px-3 py-2 text-left text-xs text-mil-dim">Severity</th>
                      <th className="px-3 py-2 text-left text-xs text-mil-dim">Category</th>
                      <th className="px-3 py-2 text-left text-xs text-mil-dim">Attribution</th>
                      <th className="px-3 py-2 text-left text-xs text-mil-dim">Area</th>
                      <th className="px-3 py-2 text-left text-xs text-mil-dim">Mod</th>
                      <th className="px-3 py-2 text-left text-xs text-mil-dim">Message</th>
                      <th className="px-3 py-2 text-left text-xs text-mil-dim"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {occurrences.map((occ) => (
                      <tr key={occ.id} className="border-b border-[rgba(232,131,58,0.06)] hover:bg-mil-bg-panel/40">
                        <td className="whitespace-nowrap px-3 py-2 text-mil-muted">
                          {fmtDate(occ.timestamp)}
                        </td>
                        <td className="whitespace-nowrap px-3 py-2 text-white">
                          {serverMap[occ.server_id] || occ.server_id}
                        </td>
                        <td className="px-3 py-2">
                          <Badge variant="outline" className={`text-xs ${severityBadge(occ.severity)}`}>
                            {occ.severity}
                          </Badge>
                        </td>
                        <td className="px-3 py-2">
                          <Badge variant="outline" className={`text-xs ${categoryBadge(occ.category)}`}>
                            {occ.category}
                          </Badge>
                        </td>
                        <td className="px-3 py-2">
                          <Badge variant="outline" className={`text-xs ${attributionTone(occ.attribution_type)}`}>
                            {humanizeToken(occ.attribution_type)}
                          </Badge>
                        </td>
                        <td className="px-3 py-2">
                          <Badge variant="outline" className={`text-xs ${areaTone(occ.designated_area)}`}>
                            {humanizeToken(occ.designated_area)}
                          </Badge>
                        </td>
                        <td className="px-3 py-2 font-mono text-xs text-mil-dim">
                          {occ.linked_mod_name || (occ.mod_guid ? occ.mod_guid.slice(0, 12) + '…' : '—')}
                        </td>
                        <td className="max-w-xs px-3 py-2 text-mil-muted" title={occ.message}>
                          <div className="flex flex-wrap gap-1">
                            {occ.review_status && (
                              <Badge variant="outline" className={`text-[11px] ${statusColor(occ.review_status)}`}>
                                {humanizeToken(occ.review_status)}
                              </Badge>
                            )}
                            {occ.actionability && (
                              <Badge variant="outline" className={`text-[11px] ${actionabilityTone(occ.actionability)}`}>
                                {humanizeToken(occ.actionability)}
                              </Badge>
                            )}
                            {occ.troublesome ? (
                              <Badge variant="outline" className="border-rose-600/30 text-[11px] text-rose-300">
                                Troublesome
                              </Badge>
                            ) : null}
                          </div>
                          <div className="mt-1 truncate">{occ.message?.slice(0, 120)}</div>
                        </td>
                        <td className="whitespace-nowrap px-3 py-2">
                          <button
                            onClick={() => fetchOccurrenceContext(occ.id)}
                            className="rounded border border-[rgba(232,131,58,0.15)] px-2 py-1 text-[11px] text-mil-muted transition-colors hover:bg-[rgba(232,131,58,0.05)] hover:text-white"
                            title="View surrounding log context"
                          >
                            <Eye className="inline mr-0.5 h-3 w-3" /> Context
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Pagination */}
              <div className="flex items-center justify-between">
                <p className="text-xs text-mil-dim">
                  Page {page} of {totalPages} ({totalCount.toLocaleString()} total)
                </p>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={page <= 1}
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                    className="border-[rgba(232,131,58,0.15)] text-mil-muted"
                  >
                    <ChevronLeft className="h-4 w-4" />
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={page >= totalPages}
                    onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                    className="border-[rgba(232,131,58,0.15)] text-mil-muted"
                  >
                    <ChevronRight className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            </>
          )}
        </>
      )}

      {/* ═══════════════════════════════════════════════════════════ */}
      {/* Tab 2: Error Patterns                                     */}
      {/* ═══════════════════════════════════════════════════════════ */}
      {activeTab === 'error-patterns' && (
        <div className="space-y-3">
          <div className="flex flex-col gap-3 sm:flex-row">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-mil-dim" />
              <Input
                value={patternSearch}
                onChange={(e) => setPatternSearch(e.target.value)}
                placeholder="Search patterns, notes, or linked mod names..."
                className="border-[rgba(232,131,58,0.15)] bg-mil-bg-panel pl-10 text-white"
              />
            </div>
            <div className="flex flex-wrap gap-2">
              {troublesomeOnly ? (
                <Badge variant="outline" className="border-rose-600/30 text-rose-300">
                  Troublesome Only
                </Badge>
              ) : null}
              {actionabilityFilter ? (
                <Badge variant="outline" className={`text-xs ${actionabilityTone(actionabilityFilter)}`}>
                  {humanizeToken(actionabilityFilter)}
                </Badge>
              ) : null}
            </div>
          </div>

          {errorTypes.length === 0 ? (
            <Card className="border-[rgba(232,131,58,0.12)] bg-mil-bg-panel/50">
              <CardContent className="flex flex-col items-center justify-center py-16 text-mil-dim">
                <Monitor className="mb-4 h-12 w-12 opacity-30" />
                <p className="text-lg font-medium">No error types catalogued</p>
              </CardContent>
            </Card>
          ) : (
            errorTypes.map((et) => (
              <Card
                key={et.id}
                className="cursor-pointer border-[rgba(232,131,58,0.12)] bg-mil-bg-panel/50 transition hover:border-[rgba(232,131,58,0.3)]"
                onClick={() => openErrorTypeDetail(et)}
              >
                <CardContent className="py-3">
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium text-white">{et.label}</span>
                      <Badge variant="outline" className={`text-xs ${severityBadge(et.severity)}`}>
                        {et.severity}
                      </Badge>
                      <Badge variant="outline" className={`text-xs ${categoryBadge(et.category)}`}>
                        {et.category}
                      </Badge>
                      <Badge variant="outline" className={`text-xs ${statusColor(et.review_status)}`}>
                        {humanizeToken(et.review_status)}
                      </Badge>
                      <Badge variant="outline" className={`text-xs ${attributionTone(et.attribution_type)}`}>
                        {humanizeToken(et.attribution_type)}
                      </Badge>
                      <Badge variant="outline" className={`text-xs ${actionabilityTone(et.actionability)}`}>
                        {humanizeToken(et.actionability)}
                      </Badge>
                      <Badge variant="outline" className={`text-xs ${areaTone(et.designated_area)}`}>
                        {humanizeToken(et.designated_area)}
                      </Badge>
                      {et.troublesome ? (
                        <Badge variant="outline" className="border-rose-600/30 text-xs text-rose-300">
                          Troublesome
                        </Badge>
                      ) : null}
                      {et.suppress_collection ? (
                        <Badge variant="outline" className="border-red-700/40 bg-red-900/30 text-xs text-red-300">
                          ⛔ Suppressed{et.suppressed_count > 0 ? ` (${et.suppressed_count.toLocaleString()})` : ''}
                        </Badge>
                      ) : null}
                    </div>
                    <div className="flex items-center gap-3 text-xs text-mil-dim">
                      <span>{(et.total_occurrences || 0).toLocaleString()} occurrences</span>
                      <span>First: {fmtDate(et.first_seen)}</span>
                      <span>Last: {fmtDate(et.last_seen)}</span>
                    </div>
                  </div>
                  <p className="mt-1 truncate font-mono text-xs text-mil-dim" title={et.normalised_message}>
                    {et.normalised_message?.slice(0, 150)}
                  </p>
                  {et.curation_notes ? (
                    <p className="mt-2 text-xs text-mil-muted">
                      {et.curation_notes}
                    </p>
                  ) : null}
                  {et.ai_summary && (
                    <p className="mt-1 text-xs text-mil-dim">
                      <Bot className="mr-1 inline h-3 w-3 text-brand-light" />
                      {et.ai_summary}
                    </p>
                  )}
                </CardContent>
              </Card>
            ))
          )}
        </div>
      )}

      {/* ═══════════════════════════════════════════════════════════ */}
      {/* Tab 3: Mod Analysis                                       */}
      {/* ═══════════════════════════════════════════════════════════ */}
      {activeTab === 'mod-analysis' && (
        <>
          {/* Mod filters */}
          <div className="flex flex-col gap-3 sm:flex-row">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-mil-dim" />
              <Input
                value={modSearch}
                onChange={(e) => setModSearch(e.target.value)}
                placeholder="Search by mod, category, stream, summary, or signature..."
                className="border-[rgba(232,131,58,0.15)] bg-mil-bg-panel pl-10 text-white"
              />
            </div>
            <select
              value={modStatusFilter}
              onChange={(e) => setModStatusFilter(e.target.value)}
              className="rounded-md border border-[rgba(232,131,58,0.15)] bg-mil-bg-panel px-3 py-2 text-sm text-white"
            >
              <option value="">All Statuses</option>
              <option value="active">Active</option>
              <option value="monitoring">Monitoring</option>
              <option value="resolved">Resolved</option>
              <option value="false_positive">False Positive</option>
            </select>
          </div>

          {/* Mod issue cards */}
          {modLoading ? (
            <div className="space-y-3">
              {[1, 2, 3].map((item) => (
                <div key={item} className="h-28 animate-pulse rounded-lg bg-mil-bg-panel/50" />
              ))}
            </div>
          ) : filteredModIssues.length === 0 ? (
            <Card className="border-[rgba(232,131,58,0.12)] bg-mil-bg-panel/50">
              <CardContent className="flex flex-col items-center justify-center py-16 text-mil-dim">
                <CheckCircle2 className="mb-4 h-12 w-12 opacity-30" />
                <p className="text-lg font-medium">No mod issues detected</p>
                <p className="mt-1 text-sm">
                  The analyzer will populate this page as merged console, profile, backend, and runtime evidence is classified.
                </p>
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-3">
              {filteredModIssues.map((issue) => (
                <Card key={issue.id} className={`border ${modSeverityColor(issue.severity)}`}>
                  <CardContent className="py-4">
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-medium text-white">
                            {issue.mod_name || 'Unattributed issue'}
                          </span>
                          <Badge className={`text-xs ${confidenceColor(issue.confidence_score || 0)}`}>
                            {Math.round((issue.confidence_score || 0) * 100)}% confidence
                          </Badge>
                          <Badge variant="outline" className="text-xs capitalize">
                            {issue.severity || 'unknown'}
                          </Badge>
                          <Badge variant="outline" className={`text-xs ${statusColor(issue.status)}`}>
                            {issue.status}
                          </Badge>
                          {issue.source_category && (
                            <Badge variant="outline" className={`text-xs ${sourceTone(issue.source_category)}`}>
                              {issue.source_category}
                            </Badge>
                          )}
                          {issue.attribution_type && (
                            <Badge variant="outline" className={`text-xs ${attributionTone(issue.attribution_type)}`}>
                              {humanizeToken(issue.attribution_type)}
                            </Badge>
                          )}
                          {issue.designated_area && (
                            <Badge variant="outline" className={`text-xs ${areaTone(issue.designated_area)}`}>
                              {humanizeToken(issue.designated_area)}
                            </Badge>
                          )}
                          {issue.issue_type && (
                            <Badge variant="outline" className="border-zinc-700 text-xs text-mil-muted">
                              {issue.issue_type}
                            </Badge>
                          )}
                          {issue.troublesome ? (
                            <Badge variant="outline" className="border-rose-600/30 text-xs text-rose-300">
                              Troublesome Mod
                            </Badge>
                          ) : null}
                        </div>

                        <p className="mt-2 text-sm text-mil-fg">
                          {issue.impact_summary || issue.error_pattern || issue.error_signature || 'No interpreted summary available.'}
                        </p>

                        <div className="mt-2 flex flex-wrap gap-4 text-xs text-mil-muted">
                          <span>{issue.occurrence_count || 0} occurrences</span>
                          <span>{(issue.affected_servers || []).length} servers affected</span>
                          {(issue.source_streams || []).length > 0 && <span>Streams: {(issue.source_streams || []).join(', ')}</span>}
                          {issue.last_seen && <span>Last seen: {new Date(issue.last_seen).toLocaleString()}</span>}
                        </div>
                      </div>

                      <div className="flex gap-2">
                        <Button onClick={() => setSelectedIssue(issue)} variant="outline" size="sm" className="border-[rgba(232,131,58,0.15)] text-mil-muted hover:text-white">
                          <Eye className="mr-1 h-3 w-3" /> Details
                        </Button>
                      </div>
                    </div>

                    <div className="mt-3 flex flex-wrap gap-1.5">
                      {VERDICT_OPTIONS.map((status) => (
                        <Button
                          key={status}
                          size="sm"
                          variant="outline"
                          onClick={() => updateIssueStatus(issue.id, status)}
                          className={`h-7 text-[11px] ${issue.status === status ? 'border-brand/40 text-brand' : 'border-zinc-700 text-mil-muted'}`}
                        >
                          {status.replace(/_/g, ' ')}
                        </Button>
                      ))}
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </>
      )}

      {/* ═══════════════════════════════════════════════════════════ */}
      {/* Tab 4: Alerts & Incidents                                 */}
      {/* ═══════════════════════════════════════════════════════════ */}
      {activeTab === 'troublesome-mods' && (
        <div className="space-y-4">
          <div className="flex flex-col gap-3 sm:flex-row">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-mil-dim" />
              <Input
                value={modSearch}
                onChange={(e) => setModSearch(e.target.value)}
                placeholder="Search troublesome mods, reasons, or attribution..."
                className="border-[rgba(232,131,58,0.15)] bg-mil-bg-panel pl-10 text-white"
              />
            </div>
          </div>

          {troublesomeLoading ? (
            <CommandLoadingState immersive={false} label="Loading troublesome mods" rows={3} />
          ) : filteredTroublesomeMods.length === 0 ? (
            <CommandEmptyState
              icon={TrendingUp}
              title="No troublesome mods curated yet"
              description="Flag a mod issue or linked error pattern as troublesome to build this list."
            />
          ) : (
            <div className="space-y-3">
              {filteredTroublesomeMods.map((item) => (
                <Card key={item.mod_id} className="border border-rose-900/30 bg-mil-bg-panel/50">
                  <CardContent className="py-4">
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-medium text-white">{item.mod_name || item.mod_id}</span>
                          <Badge variant="outline" className="border-rose-600/30 text-xs text-rose-300">
                            Troublesome
                          </Badge>
                          {(item.attribution_types || []).map((entry) => (
                            <Badge key={`${item.mod_id}-${entry}`} variant="outline" className={`text-xs ${attributionTone(entry)}`}>
                              {humanizeToken(entry)}
                            </Badge>
                          ))}
                        </div>

                        <div className="mt-2 flex flex-wrap gap-4 text-xs text-mil-muted">
                          <span>{item.issue_count || 0} curated mod issues</span>
                          <span>{item.error_type_count || 0} linked error patterns</span>
                          <span>{(item.total_occurrences || 0) + (item.pattern_occurrences || 0)} combined signals</span>
                          {item.last_seen && <span>Last seen: {fmtDate(item.last_seen)}</span>}
                        </div>

                        {item.reason ? (
                          <p className="mt-3 text-sm text-mil-fg">{item.reason}</p>
                        ) : null}

                        <div className="mt-3 flex flex-wrap gap-2">
                          {(item.source_categories || []).map((entry) => (
                            <Badge key={`${item.mod_id}-${entry}`} variant="outline" className={`text-xs ${sourceTone(entry)}`}>
                              {entry}
                            </Badge>
                          ))}
                          {(item.designated_areas || []).map((entry) => (
                            <Badge key={`${item.mod_id}-area-${entry}`} variant="outline" className={`text-xs ${areaTone(entry)}`}>
                              {humanizeToken(entry)}
                            </Badge>
                          ))}
                        </div>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </div>
      )}

      {activeTab === 'alerts' && (
        <div className="space-y-4">
          {/* Cross-link: related mod issues */}
          {summaryStats.activeModIssues > 0 && (
            <Card className="border-[rgba(232,131,58,0.12)] bg-mil-bg-panel/50">
              <CardContent className="flex items-center gap-3 py-3">
                <Package className="h-4 w-4 text-brand" />
                <span className="text-sm text-mil-muted">
                  {summaryStats.activeModIssues} active mod issue{summaryStats.activeModIssues !== 1 ? 's' : ''} may be related to current alerts.
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setActiveTab('mod-analysis')}
                  className="ml-auto text-brand hover:text-brand-light"
                >
                  View Mod Analysis →
                </Button>
              </CardContent>
            </Card>
          )}

          {alerts.length > 0 && (() => {
            const total = alertTotal ?? alerts.length;
            const orphaned = alerts.filter((alert) => !serverMap[alert.server_id]).length;
            return (
              <div className="flex flex-col gap-3 border border-[rgba(232,131,58,0.12)] bg-mil-bg-panel/50 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                <p className="text-sm text-mil-muted">
                  {total.toLocaleString()} open alert{total === 1 ? '' : 's'}
                  {total > alerts.length ? ` · newest ${alerts.length} shown` : ''}
                  {orphaned > 0 ? ` · ${orphaned} shown are from deleted servers` : ''}
                </p>
                <div className="flex flex-wrap gap-2">
                  {orphaned > 0 && (
                    <Button size="sm" variant="outline" disabled={Boolean(bulkResolving)}
                      onClick={() => resolveAlertsBulk('deleted', orphaned)}
                      className="h-11 border-[rgba(232,131,58,0.2)] text-xs text-mil-muted sm:h-8">
                      {bulkResolving === 'deleted' ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <CheckCircle2 className="mr-1 h-3 w-3" />}
                      Resolve deleted-server alerts
                    </Button>
                  )}
                  <Button size="sm" variant="outline" disabled={Boolean(bulkResolving)}
                    onClick={() => resolveAlertsBulk('all', total)}
                    className="h-11 border-[rgba(232,131,58,0.2)] text-xs text-mil-muted sm:h-8">
                    {bulkResolving === 'all' ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <CheckCircle2 className="mr-1 h-3 w-3" />}
                    Resolve all
                  </Button>
                </div>
              </div>
            );
          })()}

          {alerts.length === 0 ? (
            <Card className="border-[rgba(232,131,58,0.12)] bg-mil-bg-panel/50">
              <CardContent className="flex flex-col items-center justify-center py-16 text-mil-dim">
                <Bell className="mb-4 h-12 w-12 opacity-30" />
                <p className="text-lg font-medium">No active alerts</p>
                <p className="mt-1 text-sm">
                  Alerts will appear here when error thresholds are exceeded.
                </p>
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-2">
              {alerts.map((alert) => (
                <Card key={alert.id} className="border-[rgba(232,131,58,0.12)] bg-mil-bg-panel/50">
                  <CardContent className="py-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
                        <Badge variant="outline" className={`text-xs ${severityBadge(alert.severity)}`}>
                          {alert.severity}
                        </Badge>
                        <span className="text-sm text-mil-muted">
                          {serverMap[alert.server_id] || `Deleted server ${String(alert.server_id || '').slice(0, 8)}`}
                        </span>
                        <span className="min-w-0 text-sm text-white">{alert.reason}</span>
                        {alert.message_snippet ? (
                          <span className="basis-full truncate font-mono text-[11px] text-mil-dim" title={alert.message_snippet}>
                            {alert.message_snippet}
                          </span>
                        ) : null}
                        <span className="basis-full text-[11px] text-mil-dim">
                          {fmtDate(alert.last_triggered || alert.created_at)}
                          {alert.trigger_count > 1 ? ` · triggered ${alert.trigger_count}×` : ''}
                        </span>
                      </div>
                      <Button size="sm" variant="ghost" className="h-11 text-mil-dim hover:text-green-400 sm:h-8" onClick={() => resolveAlert(alert.id)}>
                        <CheckCircle2 className="mr-1 h-3 w-3" /> Resolve
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ═══════════════════════════════════════════════════════════ */}
      {/* Error Type detail dialog                                  */}
      {/* ═══════════════════════════════════════════════════════════ */}
      <Dialog open={!!selectedErrorType} onOpenChange={() => setSelectedErrorType(null)}>
        <DialogContent className="w-[95vw] max-h-[85vh] max-w-2xl overflow-y-auto border-[rgba(232,131,58,0.15)] bg-mil-bg-deep text-white">
          <DialogHeader>
            <DialogTitle className="text-brand-light text-base leading-tight">
              {selectedErrorType?.label}
            </DialogTitle>
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <Badge variant="outline" className={`text-[11px] ${severityBadge(selectedErrorType?.severity)}`}>
                {selectedErrorType?.severity}
              </Badge>
              <Badge variant="outline" className={`text-[11px] ${categoryBadge(selectedErrorType?.category)}`}>
                {selectedErrorType?.category}
              </Badge>
              <span className="text-[11px] text-mil-dim">
                {(selectedErrorType?.total_occurrences || 0).toLocaleString()} occurrences
              </span>
              {selectedErrorType?.first_seen && (
                <span className="text-[11px] text-mil-dim">
                  First: {fmtDate(selectedErrorType.first_seen)}
                </span>
              )}
              {selectedErrorType?.last_seen && (
                <span className="text-[11px] text-mil-dim">
                  Last: {fmtDate(selectedErrorType.last_seen)}
                </span>
              )}
            </div>
          </DialogHeader>

          {/* AI triage summary banner (from batch auto-triage) */}
          {selectedErrorType?.ai_summary && (
            <div className="rounded border border-[rgba(232,131,58,0.15)] bg-mil-bg-panel/60 px-3 py-2">
              <div className="flex items-start gap-2">
                <Bot className="mt-0.5 h-4 w-4 shrink-0 text-brand-light" />
                <div className="text-xs text-mil-muted">
                  <span className="font-medium text-white">{selectedErrorType.ai_summary}</span>
                  <div className="mt-1 flex flex-wrap gap-2">
                    {selectedErrorType.ai_severity_assessment && (
                      <span className={`capitalize inline-block rounded border px-1.5 py-0.5 text-[11px] ${severityBadge(selectedErrorType.ai_severity_assessment === 'moderate' ? 'medium' : selectedErrorType.ai_severity_assessment)}`}>
                        AI: {selectedErrorType.ai_severity_assessment}
                      </span>
                    )}
                    {selectedErrorType.ai_suggested_actionability && (
                      <span className={`capitalize inline-block rounded border px-1.5 py-0.5 text-[11px] ${actionabilityTone(selectedErrorType.ai_suggested_actionability)}`}>
                        {humanizeToken(selectedErrorType.ai_suggested_actionability)}
                      </span>
                    )}
                    {selectedErrorType.ai_suggested_attribution && (
                      <span className={`capitalize inline-block rounded border px-1.5 py-0.5 text-[11px] ${attributionTone(selectedErrorType.ai_suggested_attribution)}`}>
                        {humanizeToken(selectedErrorType.ai_suggested_attribution)}
                      </span>
                    )}
                    {selectedErrorType.ai_is_safe_to_ignore && (
                      <span className="inline-block rounded border border-green-700/30 px-1.5 py-0.5 text-[11px] text-green-400">
                        Safe to Ignore
                      </span>
                    )}
                  </div>
                </div>
              </div>
            </div>
          )}

          <Tabs defaultValue="analysis" className="mt-1">
            <TabsList className="h-8 w-full bg-mil-bg-panel border border-[rgba(232,131,58,0.12)]">
              <TabsTrigger value="analysis" className="text-xs data-[state=active]:bg-mil-bg-elevated data-[state=active]:text-brand-light">
                <Sparkles className="mr-1 h-3 w-3" /> AI Analysis
              </TabsTrigger>
              <TabsTrigger value="curation" className="text-xs data-[state=active]:bg-mil-bg-elevated data-[state=active]:text-brand-light">
                <Eye className="mr-1 h-3 w-3" /> Curation
              </TabsTrigger>
              <TabsTrigger value="occurrences" className="text-xs data-[state=active]:bg-mil-bg-elevated data-[state=active]:text-brand-light">
                <Monitor className="mr-1 h-3 w-3" /> Occurrences ({typeOccurrences.length})
              </TabsTrigger>
            </TabsList>

            {/* ── AI Analysis tab ──────────────────────────────── */}
            <TabsContent value="analysis" className="space-y-3 mt-3">
              {!aiAnalysis && !aiLoading && !aiError && (
                <div className="flex flex-col items-center gap-3 rounded-lg border border-[rgba(232,131,58,0.12)] bg-mil-bg-panel/50 px-4 py-6">
                  <Bot className="h-8 w-8 text-mil-dim" />
                  <p className="text-center text-sm text-mil-muted">
                    Use AI to get a plain-English explanation of this error, its likely root cause, and recommended actions.
                  </p>
                  <Button
                    onClick={runAiAnalysis}
                    size="sm"
                    className="border-[rgba(232,131,58,0.3)] bg-mil-bg-elevated text-brand-light hover:bg-[#282828]"
                  >
                    <Sparkles className="mr-1.5 h-3.5 w-3.5" /> Run AI Analysis
                  </Button>
                </div>
              )}

              {aiLoading && (
                <div className="flex items-center gap-2 rounded-lg border border-[rgba(232,131,58,0.12)] bg-mil-bg-panel/50 px-4 py-6">
                  <RefreshCw className="h-4 w-4 animate-spin text-brand-light" />
                  <span className="text-sm text-mil-muted">Analysing error pattern…</span>
                </div>
              )}

              {aiError && (
                <div className="rounded-lg border border-red-800/30 bg-red-950/20 p-3">
                  <p className="text-sm text-red-300">{aiError}</p>
                  <Button onClick={runAiAnalysis} size="sm" variant="ghost" className="mt-2 text-xs text-red-300 hover:text-white">
                    Retry
                  </Button>
                </div>
              )}

              {aiAnalysis && (
                <div className="space-y-3">
                  <div className="rounded-lg border border-[rgba(232,131,58,0.12)] bg-mil-bg-panel/50 p-3">
                    <p className="mb-1 text-xs text-mil-muted font-medium">Summary</p>
                    <p className="text-sm text-mil-fg">{aiAnalysis.summary}</p>
                  </div>

                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <div className="rounded-lg border border-[rgba(232,131,58,0.12)] bg-mil-bg-panel/50 p-3">
                      <p className="mb-1 text-xs text-mil-muted font-medium">Root Cause</p>
                      <p className="text-sm text-mil-fg">{aiAnalysis.root_cause || '—'}</p>
                    </div>
                    <div className="rounded-lg border border-[rgba(232,131,58,0.12)] bg-mil-bg-panel/50 p-3">
                      <p className="mb-1 text-xs text-mil-muted font-medium">Impact</p>
                      <p className="text-sm text-mil-fg">{aiAnalysis.impact || '—'}</p>
                    </div>
                  </div>

                  <div className="flex flex-wrap gap-2">
                    {aiAnalysis.severity_assessment && (
                      <Badge variant="outline" className={`text-[11px] ${
                        aiAnalysis.severity_assessment === 'critical' || aiAnalysis.severity_assessment === 'high'
                          ? 'border-red-600/30 text-red-300'
                          : aiAnalysis.severity_assessment === 'moderate'
                            ? 'border-yellow-600/30 text-yellow-300'
                            : 'border-green-600/30 text-green-300'
                      }`}>
                        AI severity: {aiAnalysis.severity_assessment}
                      </Badge>
                    )}
                    {aiAnalysis.is_safe_to_ignore !== null && aiAnalysis.is_safe_to_ignore !== undefined && (
                      <Badge variant="outline" className={`text-[11px] ${
                        aiAnalysis.is_safe_to_ignore
                          ? 'border-green-600/30 text-green-300'
                          : 'border-orange-600/30 text-orange-300'
                      }`}>
                        {aiAnalysis.is_safe_to_ignore ? 'Safe to ignore' : 'Needs attention'}
                      </Badge>
                    )}
                  </div>

                  {(aiAnalysis.recommended_actions || []).length > 0 && (
                    <div className="rounded-lg border border-[rgba(232,131,58,0.12)] bg-mil-bg-panel/50 p-3">
                      <p className="mb-2 text-xs text-mil-muted font-medium">Recommended Actions</p>
                      <ul className="space-y-1">
                        {aiAnalysis.recommended_actions.map((action, i) => (
                          <li key={i} className="flex items-start gap-2 text-sm text-mil-fg">
                            <CheckCircle2 className="mt-0.5 h-3 w-3 shrink-0 text-mil-dim" />
                            {action}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {/* AI Curation Suggestions */}
                  {(aiAnalysis.suggested_review_status || aiAnalysis.suggested_actionability || aiAnalysis.suggested_attribution) && (
                    <div className="rounded-lg border border-cyan-700/20 bg-cyan-950/10 p-3">
                      <div className="mb-2 flex items-center justify-between">
                        <p className="text-xs text-cyan-400/60 font-medium">AI Curation Suggestions</p>
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-6 border-cyan-700/30 px-2 text-[11px] text-cyan-400 hover:bg-cyan-700/10"
                          onClick={() => {
                            if (aiAnalysis.suggested_review_status) setTypeReviewStatus(aiAnalysis.suggested_review_status);
                            if (aiAnalysis.suggested_actionability) setTypeActionability(aiAnalysis.suggested_actionability);
                            if (aiAnalysis.suggested_attribution) setTypeAttribution(aiAnalysis.suggested_attribution);
                          }}
                        >
                          Apply to curation
                        </Button>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        {aiAnalysis.suggested_review_status && (
                          <Badge variant="outline" className="border-cyan-700/30 text-[11px] text-cyan-300">
                            Status: {aiAnalysis.suggested_review_status}
                          </Badge>
                        )}
                        {aiAnalysis.suggested_actionability && (
                          <Badge variant="outline" className="border-cyan-700/30 text-[11px] text-cyan-300">
                            Actionability: {aiAnalysis.suggested_actionability}
                          </Badge>
                        )}
                        {aiAnalysis.suggested_attribution && (
                          <Badge variant="outline" className="border-cyan-700/30 text-[11px] text-cyan-300">
                            Attribution: {aiAnalysis.suggested_attribution}
                          </Badge>
                        )}
                      </div>
                    </div>
                  )}

                  <Button onClick={runAiAnalysis} size="sm" variant="ghost" className="text-xs text-mil-dim hover:text-white">
                    <RefreshCw className="mr-1 h-3 w-3" /> Re-analyse
                  </Button>
                </div>
              )}

              {/* Collapsible raw message */}
              <button
                type="button"
                onClick={() => setShowRawMessage((v) => !v)}
                className="flex w-full items-center gap-1 text-[11px] text-mil-dim hover:text-mil-muted"
              >
                {showRawMessage ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                Raw message &amp; pattern
              </button>
              {showRawMessage && (
                <div className="space-y-2">
                  <pre className="max-h-24 overflow-auto rounded bg-mil-bg-panel p-2 font-mono text-[11px] text-mil-muted whitespace-pre-wrap break-all">
                    {selectedErrorType?.example_raw}
                  </pre>
                  <pre className="rounded bg-mil-bg-panel p-2 font-mono text-[11px] text-mil-dim whitespace-pre-wrap break-all">
                    {selectedErrorType?.normalised_message}
                  </pre>
                </div>
              )}
            </TabsContent>

            {/* ── Pattern Curation tab ─────────────────────────── */}
            <TabsContent value="curation" className="mt-3">
              <div className="space-y-3">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <div>
                    <p className="mb-1 text-xs text-mil-muted font-medium">Review Status</p>
                    <select
                      value={typeReviewStatus}
                      onChange={(e) => setTypeReviewStatus(e.target.value)}
                      className="w-full rounded-md border border-[rgba(232,131,58,0.15)] bg-mil-bg-deep px-2 py-1.5 text-xs text-white"
                    >
                      {VERDICT_OPTIONS.map((status) => (
                        <option key={status} value={status}>{humanizeToken(status)}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <p className="mb-1 text-xs text-mil-muted font-medium">Attribution</p>
                    <select
                      value={typeAttribution}
                      onChange={(e) => setTypeAttribution(e.target.value)}
                      className="w-full rounded-md border border-[rgba(232,131,58,0.15)] bg-mil-bg-deep px-2 py-1.5 text-xs text-white"
                    >
                      {ATTRIBUTION_OPTIONS.map((entry) => (
                        <option key={entry} value={entry}>{humanizeToken(entry)}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <p className="mb-1 text-xs text-mil-muted font-medium">Diagnostics Area</p>
                    <select
                      value={typeArea}
                      onChange={(e) => setTypeArea(e.target.value)}
                      className="w-full rounded-md border border-[rgba(232,131,58,0.15)] bg-mil-bg-deep px-2 py-1.5 text-xs text-white"
                    >
                      {AREA_OPTIONS.map((entry) => (
                        <option key={entry} value={entry}>{humanizeToken(entry)}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <p className="mb-1 text-xs text-mil-muted font-medium">Actionability</p>
                    <select
                      value={typeActionability}
                      onChange={(e) => setTypeActionability(e.target.value)}
                      className="w-full rounded-md border border-[rgba(232,131,58,0.15)] bg-mil-bg-deep px-2 py-1.5 text-xs text-white"
                    >
                      {ACTIONABILITY_OPTIONS.map((entry) => (
                        <option key={entry} value={entry}>{humanizeToken(entry)}</option>
                      ))}
                    </select>
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <div>
                    <p className="mb-1 text-xs text-mil-muted font-medium">Known Mod GUID</p>
                    <Input
                      value={typeLinkedModGuid}
                      onChange={(e) => setTypeLinkedModGuid(e.target.value)}
                      className="h-8 border-[rgba(232,131,58,0.15)] bg-mil-bg-deep text-xs text-white"
                      placeholder="Optional GUID"
                    />
                  </div>
                  <div>
                    <p className="mb-1 text-xs text-mil-muted font-medium">Known Mod Name</p>
                    <Input
                      value={typeLinkedModName}
                      onChange={(e) => setTypeLinkedModName(e.target.value)}
                      className="h-8 border-[rgba(232,131,58,0.15)] bg-mil-bg-deep text-xs text-white"
                      placeholder="Optional linked mod"
                    />
                  </div>
                </div>

                <div>
                  <p className="mb-1 text-xs text-mil-muted font-medium">Quick Fill From Known Mods</p>
                  <select
                    value=""
                    onChange={(e) => {
                      const selectedGuid = e.target.value;
                      const selectedMod = knownMods.find((item) => item.guid === selectedGuid);
                      if (selectedMod) {
                        setTypeLinkedModGuid(selectedMod.guid || '');
                        setTypeLinkedModName(selectedMod.name || '');
                      }
                    }}
                    className="w-full rounded-md border border-[rgba(232,131,58,0.15)] bg-mil-bg-deep px-2 py-1.5 text-xs text-white"
                  >
                    <option value="">Select a known mod...</option>
                    {knownMods.map((item) => (
                      <option key={item.guid || item.id} value={item.guid}>
                        {item.name || item.guid}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => setTypeSuppressCollection((current) => !current)}
                    className={`text-xs border-[rgba(232,131,58,0.15)] ${typeSuppressCollection ? 'text-red-400 border-red-700/40' : 'text-mil-muted'}`}
                  >
                    {typeSuppressCollection ? '⛔ Collection Suppressed' : 'Suppress Collection'}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => setTypeTroublesome((current) => !current)}
                    className={`text-xs border-[rgba(232,131,58,0.15)] ${typeTroublesome ? 'text-rose-300' : 'text-mil-muted'}`}
                  >
                    {typeTroublesome ? 'Troublesome Linked Mod' : 'Mark Linked Mod As Troublesome'}
                  </Button>
                  <Badge variant="outline" className={`text-[11px] ${statusColor(typeReviewStatus)}`}>
                    {humanizeToken(typeReviewStatus)}
                  </Badge>
                  <Badge variant="outline" className={`text-[11px] ${attributionTone(typeAttribution)}`}>
                    {humanizeToken(typeAttribution)}
                  </Badge>
                  <Badge variant="outline" className={`text-[11px] ${areaTone(typeArea)}`}>
                    {humanizeToken(typeArea)}
                  </Badge>
                  {typeSuppressCollection && (
                    <Badge variant="outline" className="text-[11px] bg-red-900/30 text-red-300 border-red-700/40">
                      {selectedErrorType?.suppressed_count > 0 ? `${selectedErrorType.suppressed_count} suppressed` : 'Suppressed'}
                    </Badge>
                  )}
                </div>

                <Textarea
                  value={typeNotes}
                  onChange={(e) => setTypeNotes(e.target.value)}
                  className="border-[rgba(232,131,58,0.15)] bg-mil-bg-deep text-xs text-white"
                  rows={2}
                  placeholder="Operator notes, false-positive rationale, or known-safe context..."
                />

                <div className="flex justify-end">
                  <Button
                    onClick={saveErrorTypeCuration}
                    size="sm"
                    variant="outline"
                    disabled={typeSaving}
                    className="border-[rgba(232,131,58,0.15)] text-mil-muted hover:text-white"
                  >
                    {typeSaving ? 'Saving...' : 'Save Curation'}
                  </Button>
                </div>
              </div>
            </TabsContent>

            {/* ── Occurrences tab ──────────────────────────────── */}
            <TabsContent value="occurrences" className="mt-3">
              {typeOccLoading ? (
                <div className="h-20 animate-pulse rounded bg-mil-bg-panel/50" />
              ) : typeOccurrences.length === 0 ? (
                <p className="py-4 text-center text-sm text-mil-dim">No occurrences found.</p>
              ) : (
                <div className="max-h-[50vh] space-y-2 overflow-y-auto">
                  {typeOccurrences.map((occ) => (
                    <div key={occ.id} className="rounded bg-mil-bg-panel/60 px-3 py-2 text-xs">
                      <div className="flex items-center gap-2 text-mil-dim">
                        <Server className="h-3 w-3" />
                        <span>{serverMap[occ.server_id] || occ.server_id}</span>
                        <span>•</span>
                        <span>{fmtDate(occ.timestamp)}</span>
                        {occ.mod_guid && (
                          <>
                            <span>•</span>
                            <span className="font-mono">{occ.mod_guid.slice(0, 12)}</span>
                          </>
                        )}
                      </div>
                      <p className="mt-1 whitespace-pre-wrap break-all text-mil-muted">{occ.raw?.slice(0, 400)}</p>
                    </div>
                  ))}
                </div>
              )}
            </TabsContent>
          </Tabs>
        </DialogContent>
      </Dialog>

      {/* ═══════════════════════════════════════════════════════════ */}
      {/* Mod Issue detail dialog                                   */}
      {/* ═══════════════════════════════════════════════════════════ */}
      <Dialog open={!!selectedIssue} onOpenChange={() => setSelectedIssue(null)}>
        <DialogContent className="w-[95vw] max-h-[80vh] max-w-2xl overflow-y-auto border-[rgba(232,131,58,0.12)] bg-mil-bg-deep text-white">
          {selectedIssue && (
            <>
              <DialogHeader>
                <DialogTitle className="text-brand">
                  {(selectedIssue.mod_name || 'Unattributed issue')} - Details
                </DialogTitle>
              </DialogHeader>

              <div className="space-y-4">
                <div className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
                  <div><span className="text-mil-dim">Mod ID:</span> <span className="font-mono text-mil-muted">{selectedIssue.mod_id || 'unattributed'}</span></div>
                  <div><span className="text-mil-dim">Status:</span> <Badge variant="outline" className="ml-1 text-xs">{selectedIssue.status}</Badge></div>
                  <div><span className="text-mil-dim">Severity:</span> <span className="text-mil-muted">{selectedIssue.severity || 'unknown'}</span></div>
                  <div><span className="text-mil-dim">Method:</span> <span className="text-mil-muted">{selectedIssue.attribution_method || 'unknown'}</span></div>
                  <div><span className="text-mil-dim">Source category:</span> <span className="text-mil-muted">{selectedIssue.source_category || 'unknown'}</span></div>
                  <div><span className="text-mil-dim">Issue type:</span> <span className="text-mil-muted">{selectedIssue.issue_type || 'unknown'}</span></div>
                  <div><span className="text-mil-dim">Confidence:</span> <Badge className={`ml-1 text-xs ${confidenceColor(selectedIssue.confidence_score || 0)}`}>{Math.round((selectedIssue.confidence_score || 0) * 100)}%</Badge></div>
                  <div><span className="text-mil-dim">Occurrences:</span> <span className="text-mil-muted">{selectedIssue.occurrence_count || 0}</span></div>
                  <div>
                    <span className="text-mil-dim">Diagnostics area:</span>
                    <Badge variant="outline" className={`ml-1 text-xs ${areaTone(issueArea)}`}>
                      {humanizeToken(issueArea)}
                    </Badge>
                  </div>
                  <div>
                    <span className="text-mil-dim">Attribution:</span>
                    <Badge variant="outline" className={`ml-1 text-xs ${attributionTone(issueAttribution)}`}>
                      {humanizeToken(issueAttribution)}
                    </Badge>
                  </div>
                  <div>
                    <span className="text-mil-dim">Troublesome:</span>
                    <Badge
                      variant="outline"
                      className={`ml-1 text-xs ${issueTroublesome ? 'border-rose-600/30 text-rose-300' : 'border-zinc-700 text-mil-muted'}`}
                    >
                      {issueTroublesome ? 'Yes' : 'No'}
                    </Badge>
                  </div>
                </div>

                {(selectedIssue.source_streams || []).length > 0 && (
                  <div className="rounded-lg border border-[rgba(232,131,58,0.12)] bg-mil-bg-panel/50 p-3">
                    <p className="mb-2 text-xs text-mil-dim">Source Streams</p>
                    <div className="flex flex-wrap gap-2">
                      {(selectedIssue.source_streams || []).map((stream) => (
                        <Badge key={stream} variant="outline" className="border-zinc-700 text-mil-muted">
                          {stream}
                        </Badge>
                      ))}
                    </div>
                  </div>
                )}

                <div className="rounded-lg border border-[rgba(232,131,58,0.12)] bg-mil-bg-panel/50 p-3">
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-sm text-mil-muted">Issue classification</p>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={saveIssueCuration}
                      className="border-[rgba(232,131,58,0.15)] text-mil-muted hover:text-white"
                    >
                      Save Classification
                    </Button>
                  </div>
                  <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <div>
                      <p className="mb-1 text-xs text-mil-muted font-medium">Diagnostics Area</p>
                      <select
                        value={issueArea}
                        onChange={(e) => setIssueArea(e.target.value)}
                        className="w-full rounded-md border border-[rgba(232,131,58,0.15)] bg-mil-bg-deep px-3 py-2 text-sm text-white"
                      >
                        {AREA_OPTIONS.map((entry) => (
                          <option key={entry} value={entry}>{humanizeToken(entry)}</option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <p className="mb-1 text-xs text-mil-muted font-medium">Attribution</p>
                      <select
                        value={issueAttribution}
                        onChange={(e) => setIssueAttribution(e.target.value)}
                        className="w-full rounded-md border border-[rgba(232,131,58,0.15)] bg-mil-bg-deep px-3 py-2 text-sm text-white"
                      >
                        {ATTRIBUTION_OPTIONS.map((entry) => (
                          <option key={entry} value={entry}>{humanizeToken(entry)}</option>
                        ))}
                      </select>
                    </div>
                  </div>
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        setIssueTroublesome((current) => {
                          const next = !current;
                          if (next) {
                            setIssueArea('troublesome-mods');
                          }
                          return next;
                        });
                      }}
                      className={`border-[rgba(232,131,58,0.15)] ${issueTroublesome ? 'text-rose-300' : 'text-mil-muted'}`}
                    >
                      {issueTroublesome ? 'Troublesome Mod Flagged' : 'Mark As Troublesome Mod'}
                    </Button>
                    <Badge variant="outline" className={`text-xs ${areaTone(issueArea)}`}>
                      {humanizeToken(issueArea)}
                    </Badge>
                    <Badge variant="outline" className={`text-xs ${attributionTone(issueAttribution)}`}>
                      {humanizeToken(issueAttribution)}
                    </Badge>
                  </div>
                  <Textarea
                    value={issueTroublesomeReason}
                    onChange={(e) => setIssueTroublesomeReason(e.target.value)}
                    className="mt-3 border-[rgba(232,131,58,0.15)] bg-mil-bg-deep text-white"
                    rows={3}
                    placeholder="Why is this mod considered troublesome, recurring, or worth tracking?"
                  />
                </div>

                <div className="rounded-lg border border-[rgba(232,131,58,0.12)] bg-mil-bg-panel/50 p-3">
                  <p className="mb-2 text-xs text-mil-dim">Impact Summary</p>
                  <p className="text-sm text-mil-fg">
                    {selectedIssue.impact_summary || 'No interpreted impact summary is available for this issue yet.'}
                  </p>
                </div>

                <div className="rounded-lg border border-[rgba(232,131,58,0.12)] bg-mil-bg-panel/50 p-3">
                  <p className="mb-2 flex items-center gap-1 text-xs text-mil-dim">
                    <Clock className="h-3 w-3" /> Timeline
                  </p>
                  <div className="flex flex-wrap gap-4 text-xs text-mil-muted">
                    {selectedIssue.first_seen && (
                      <div>
                        <span className="text-mil-dim">First seen: </span>
                        <span>{new Date(selectedIssue.first_seen).toLocaleString()}</span>
                      </div>
                    )}
                    {selectedIssue.last_seen && (
                      <div>
                        <span className="text-mil-dim">Last seen: </span>
                        <span>{new Date(selectedIssue.last_seen).toLocaleString()}</span>
                      </div>
                    )}
                    {(selectedIssue.occurrence_count || 0) > 1 && (
                      <div className="flex items-center gap-1 text-amber-400">
                        <TrendingUp className="h-3 w-3" />
                        <span>{selectedIssue.occurrence_count} repeated detections</span>
                      </div>
                    )}
                  </div>
                </div>

                {(selectedIssue.affected_servers || []).length > 0 && (
                  <div className="rounded-lg border border-[rgba(232,131,58,0.12)] bg-mil-bg-panel/50 p-3">
                    <p className="mb-2 flex items-center gap-1 text-xs text-mil-dim">
                      <Server className="h-3 w-3" /> Affected Servers
                    </p>
                    <div className="flex flex-wrap gap-2">
                      {selectedIssue.affected_servers.map((server, index) => (
                        <Badge key={index} variant="outline" className="border-red-600/30 text-xs text-red-400">
                          <Server className="mr-1 h-2.5 w-2.5" />
                          {server.server_name || server.server_id || `Server ${index + 1}`}
                        </Badge>
                      ))}
                    </div>
                  </div>
                )}

                {selectedIssue.error_pattern && (
                  <div>
                    <p className="mb-1 text-sm text-mil-dim">Error Pattern</p>
                    <pre className="overflow-x-auto rounded bg-mil-bg-panel p-3 text-xs text-mil-muted">{selectedIssue.error_pattern}</pre>
                  </div>
                )}

                {(selectedIssue.recommended_actions || []).length > 0 && (
                  <div>
                    <p className="mb-1 text-sm text-mil-dim">Recommended Actions</p>
                    <div className="flex flex-wrap gap-2">
                      {selectedIssue.recommended_actions.map((action, index) => (
                        <Badge key={index} variant="outline" className="border-brand/30 text-xs text-brand">
                          {String(action).replace(/_/g, ' ')}
                        </Badge>
                      ))}
                    </div>
                  </div>
                )}

                {(selectedIssue.evidence || []).length > 0 && (
                  <div>
                    <p className="mb-1 text-sm text-mil-dim">Evidence ({selectedIssue.evidence.length})</p>
                    <div className="max-h-48 space-y-2 overflow-y-auto">
                      {selectedIssue.evidence.slice(0, 8).map((evidence, index) => (
                        <pre key={index} className="rounded bg-mil-bg-panel p-2 text-xs text-mil-muted">
                          {evidence.log_excerpt || JSON.stringify(evidence, null, 2)}
                        </pre>
                      ))}
                    </div>
                  </div>
                )}

                <div className="border-t border-[rgba(232,131,58,0.12)] pt-4">
                  <p className="mb-2 text-sm text-mil-muted">Operator verdict</p>
                  <div className="flex flex-wrap gap-2">
                    {VERDICT_OPTIONS.map((status) => (
                      <Button
                        key={status}
                        size="sm"
                        variant="outline"
                        onClick={() => updateIssueStatus(selectedIssue.id, status, resolutionNotes, {
                          designated_area: issueArea,
                          attribution_type: issueAttribution,
                          troublesome: issueTroublesome,
                          troublesome_reason: issueTroublesomeReason,
                        })}
                        className={`text-xs ${selectedIssue.status === status ? 'border-brand/40 text-brand' : 'border-zinc-700 text-mil-muted'}`}
                      >
                        {status.replace(/_/g, ' ')}
                      </Button>
                    ))}
                  </div>
                  <Textarea
                    value={resolutionNotes}
                    onChange={(e) => setResolutionNotes(e.target.value)}
                    className="mt-3 border-[rgba(232,131,58,0.15)] bg-mil-bg-panel text-white"
                    rows={3}
                    placeholder="Resolution or operator notes..."
                  />
                </div>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

export default ServerDiagnostics;
