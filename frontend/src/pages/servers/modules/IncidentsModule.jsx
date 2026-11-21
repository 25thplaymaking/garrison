import React, { useState, useEffect, useCallback } from 'react';
import { Link, useOutletContext } from 'react-router';
import apiClient from '@/lib/apiClient';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  AlertTriangle,
  AlertOctagon,
  CheckCircle,
  Clock,
  RefreshCw,
  Loader2,
  Search,
  Trash2,
} from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import useConfirmDialog from '@/hooks/useConfirmDialog';
import { CommandEmptyState, CommandLoadingState } from '@/components/tactical/CommandUI';
import { formatApiError } from '@/utils/errorMessages';

function IncidentsModule({ embedded = false }) {
  const { serverId, canManage } = useOutletContext();
  const [incidents, setIncidents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState('');
  // Open first: the list is for triage, and resolved history is one click away.
  const [statusFilter, setStatusFilter] = useState('open');
  const [bulkResolving, setBulkResolving] = useState(false);
  const [activeIncidentId, setActiveIncidentId] = useState(null);
  const [resolveTarget, setResolveTarget] = useState(null);
  const [resolutionNotes, setResolutionNotes] = useState('');
  const { confirm, dialog: confirmDialog } = useConfirmDialog();

  const fetchIncidents = useCallback(async () => {
    setLoading(true);
    try {
      const params = statusFilter !== 'all' ? `?status=${statusFilter}` : '';
      const res = await apiClient.get(`/servers/${serverId}/incidents${params}`);
      setError('');
      setIncidents(res.data?.incidents || res.data || []);
    } catch (err) {
      setError(formatApiError(err, 'Failed to load incidents.'));
      setIncidents([]);
    } finally {
      setLoading(false);
    }
  }, [serverId, statusFilter]);

  useEffect(() => { fetchIncidents(); }, [fetchIncidents]);

  const handleResolveDialogChange = useCallback((open) => {
    if (open) {
      return;
    }
    setResolveTarget(null);
    setResolutionNotes('');
  }, []);

  const openResolveDialog = useCallback((incident) => {
    setResolveTarget(incident);
    setResolutionNotes(incident?.resolution_notes || '');
  }, []);

  const resolveIncident = useCallback(async () => {
    if (!resolveTarget?.id) {
      return;
    }
    setActiveIncidentId(resolveTarget.id);
    try {
      await apiClient.post(`/servers/${serverId}/incidents/${resolveTarget.id}/resolve`, {
        resolution_notes: resolutionNotes.trim(),
      });
      setError('');
      setResolveTarget(null);
      setResolutionNotes('');
      await fetchIncidents();
    } catch (err) {
      setError(formatApiError(err, 'Failed to resolve incident.'));
    } finally {
      setActiveIncidentId(null);
    }
  }, [fetchIncidents, resolutionNotes, resolveTarget, serverId]);

  const deleteIncident = useCallback(async (incident) => {
    if (!incident?.id) {
      return;
    }
    if (!(await confirm({
      title: 'Remove Incident',
      description: `Remove incident "${incident.title || 'Untitled Incident'}"?`,
      destructive: true,
      confirmLabel: 'Delete',
    }))) {
      return;
    }
    setActiveIncidentId(incident.id);
    try {
      await apiClient.delete(`/servers/${serverId}/incidents/${incident.id}`);
      setError('');
      await fetchIncidents();
    } catch (err) {
      setError(formatApiError(err, 'Failed to delete incident.'));
    } finally {
      setActiveIncidentId(null);
    }
  }, [confirm, fetchIncidents, serverId]);

  const openIncidents = incidents.filter((inc) => inc.status === 'open' || inc.status === 'investigating');

  // Auto-detected failures pile up while a server is down for days; clearing
  // them one dialog at a time is why they were being deleted instead.
  const resolveAllOpen = useCallback(async () => {
    if (openIncidents.length === 0) return;
    if (!(await confirm({
      title: 'Resolve Open Incidents',
      description: `Mark all ${openIncidents.length} open incident${openIncidents.length === 1 ? '' : 's'} on this server resolved? They stay in the history under Resolved.`,
      confirmLabel: 'Resolve all',
    }))) {
      return;
    }
    setBulkResolving(true);
    const failures = [];
    for (const incident of openIncidents) {
      try {
        await apiClient.post(`/servers/${serverId}/incidents/${incident.id}/resolve`, {
          resolution_notes: 'Resolved in bulk from the incidents list.',
        });
      } catch (err) {
        failures.push(formatApiError(err, `Could not resolve "${incident.title || incident.id}".`));
      }
    }
    setError(failures.length ? `${failures.length} could not be resolved: ${failures[0]}` : '');
    setBulkResolving(false);
    await fetchIncidents();
  }, [confirm, fetchIncidents, openIncidents, serverId]);

  const filtered = incidents.filter(inc => {
    if (!filter) return true;
    const q = filter.toLowerCase();
    return inc.title?.toLowerCase().includes(q) || inc.description?.toLowerCase().includes(q);
  });

  const severityIcon = (sev) => {
    if (sev === 'critical') return <AlertOctagon className="h-4 w-4 text-red-400" />;
    if (sev === 'high') return <AlertTriangle className="h-4 w-4 text-amber-400" />;
    return <AlertTriangle className="h-4 w-4 text-mil-muted" />;
  };

  const statusBadge = (status) => {
    const map = {
      open: 'border-red-600/30 text-red-400',
      investigating: 'border-amber-600/30 text-amber-400',
      resolved: 'border-green-600/30 text-green-400',
    };
    return map[status] || 'border-zinc-600/30 text-mil-muted';
  };

  return (
    <div className="space-y-6">
      {confirmDialog}
      <div className={`flex flex-wrap items-center gap-2 ${embedded ? 'justify-end' : 'justify-between'}`}>
        {/* Inside Health & Alerts the module header already names the tab. */}
        {!embedded && (
          <h2 className="text-sm font-semibold tracking-wider text-mil-muted" style={{ fontFamily: "var(--font-heading)" }}>
            Incidents & Troubleshooting
          </h2>
        )}
        <div className="flex flex-wrap items-center gap-2">
          {canManage && openIncidents.length > 1 && (
            <Button size="sm" variant="outline" onClick={resolveAllOpen} disabled={bulkResolving}
              className="h-11 border-zinc-800 text-xs text-mil-muted sm:h-8">
              {bulkResolving ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <CheckCircle className="mr-1 h-3 w-3" />}
              Resolve all open ({openIncidents.length})
            </Button>
          )}
          <Button size="sm" variant="outline" onClick={fetchIncidents}
            className="h-11 border-zinc-800 text-xs text-mil-muted sm:h-8">
            <RefreshCw className={`mr-1 h-3 w-3 ${loading ? 'animate-spin' : ''}`} /> Refresh
          </Button>
        </div>
      </div>

      {error && (
        <div className="rounded border border-red-600/30 bg-red-600/10 px-3 py-2 text-xs text-red-300">
          {error}
        </div>
      )}

      {/* Filters */}
      <div className="flex flex-wrap gap-2">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-mil-dim" />
          <Input value={filter} onChange={(e) => setFilter(e.target.value)}
            placeholder="Search incidents..."
            className="h-8 border-zinc-800 bg-mil-bg-deep/60 pl-9 text-xs text-white placeholder:text-mil-dim" />
        </div>
        {['all', 'open', 'investigating', 'resolved'].map((s) => (
          <Button key={s} size="sm" variant={statusFilter === s ? 'default' : 'outline'}
            onClick={() => setStatusFilter(s)}
            className={`h-11 text-xs sm:h-8 ${statusFilter === s
              ? 'bg-brand text-black'
              : 'border-zinc-800 text-mil-muted'
            }`}>
            {s.charAt(0).toUpperCase() + s.slice(1)}
          </Button>
        ))}
      </div>

      {/* Incidents list */}
      {loading ? (
        <CommandLoadingState immersive={false} label="Loading incidents" rows={3} />
      ) : filtered.length === 0 ? (
        <CommandEmptyState
          icon={CheckCircle}
          title="No incidents found"
          description={statusFilter === 'open' ? 'All clear: no open incidents.' : 'No incidents match your search.'}
        />
      ) : (
        <div className="space-y-2">
          {filtered.map((inc, i) => (
            <Card key={inc.id || i} className="border-zinc-800 bg-mil-bg-deep/60 hover:border-zinc-700 transition-colors">
              <CardContent className="p-4">
                <div className="flex items-start gap-3">
                  {severityIcon(inc.severity)}
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-medium text-mil-fg">{inc.title || 'Untitled Incident'}</span>
                        <Badge variant="outline" className={`${statusBadge(inc.status)} text-[11px]`}>
                          {inc.status?.toUpperCase()}
                        </Badge>
                        <Badge variant="outline" className={`text-[11px] ${
                          inc.severity === 'critical' ? 'border-red-600/30 text-red-400' :
                          inc.severity === 'high' ? 'border-amber-600/30 text-amber-400' :
                          'border-zinc-600/30 text-mil-muted'
                        }`}>
                          {inc.severity?.toUpperCase()}
                        </Badge>
                        {inc.auto_detected && (
                          <Badge variant="outline" className="border-blue-600/30 text-blue-400 text-[11px]">AUTO</Badge>
                        )}
                      </div>
                      {canManage && (
                        <div className="flex items-center gap-2">
                          {inc.status !== 'resolved' && (
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => openResolveDialog(inc)}
                              disabled={activeIncidentId === inc.id}
                              className="h-11 border-zinc-800 text-xs text-mil-muted sm:h-7"
                            >
                              {activeIncidentId === inc.id ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : null}
                              Resolve
                            </Button>
                          )}
                          {/* Resolve keeps the history; deleting was the louder,
                              red button and got used 21 times to 1 resolve. */}
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => deleteIncident(inc)}
                            disabled={activeIncidentId === inc.id}
                            aria-label={`Delete incident ${inc.title || ''}`.trim()}
                            title="Delete incident"
                            className="h-11 w-11 p-0 text-mil-dim hover:bg-red-950/40 hover:text-red-300 sm:h-7 sm:w-7"
                          >
                            {activeIncidentId === inc.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                          </Button>
                        </div>
                      )}
                    </div>
                    {inc.description && (
                      <p className="mt-1 line-clamp-2 break-words text-xs text-mil-muted">{inc.description}</p>
                    )}
                    {inc.diagnosis ? (
                      <div className="mt-2 rounded-md border border-red-500/20 bg-red-500/[0.06] p-2.5">
                        <p className="text-xs font-medium text-red-200">{inc.diagnosis.title}</p>
                        <p className="mt-0.5 break-words font-mono text-[11px] text-mil-muted">{inc.diagnosis.summary}</p>
                        {inc.diagnosis.culprits?.length > 0 && (
                          <p className="mt-1 text-[11px] text-mil-dim">
                            Likely mod: {inc.diagnosis.culprits.map((c) => c.name).join(', ')}
                          </p>
                        )}
                        <Link
                          to={`/servers/${serverId}/diagnosis`}
                          className="mt-1.5 inline-block text-[11px] font-medium text-brand-light hover:underline"
                        >
                          Open crash analysis and fixes
                        </Link>
                      </div>
                    ) : inc.evidence?.length > 0 && (
                      <div className="mt-2 rounded border border-zinc-800 bg-mil-bg-deep/80 p-2 font-mono text-[11px] text-mil-dim">
                        {inc.evidence.slice(0, 3).map((line, j) => (
                          <div key={j} className="truncate">{line}</div>
                        ))}
                      </div>
                    )}
                    <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-mil-dim">
                      <span className="flex items-center gap-1">
                        <Clock className="h-3 w-3" />
                        {inc.detected_at ? new Date(inc.detected_at).toLocaleString() : '—'}
                      </span>
                      {inc.occurrences > 1 && (
                        <span className="text-amber-300/80">
                          Seen {inc.occurrences}×{inc.last_detected_at ? `, last ${new Date(inc.last_detected_at).toLocaleString()}` : ''}
                        </span>
                      )}
                      {inc.incident_type && <span>Type: {inc.incident_type}</span>}
                      {inc.related_mod_issues?.length > 0 && (
                        <span className="text-amber-400">{inc.related_mod_issues.length} related mod issues</span>
                      )}
                    </div>
                    {inc.log_excerpts?.length > 0 && (
                      <div className="mt-2 rounded border border-zinc-800 bg-mil-bg-deep/80 p-2">
                        <div className="font-mono text-[11px] text-mil-dim max-h-20 overflow-hidden">
                          {inc.log_excerpts.slice(0, 3).map((log, j) => (
                            <div key={j} className="truncate" title={log}>{log}</div>
                          ))}
                        </div>
                      </div>
                    )}
                    {inc.status === 'resolved' && (inc.resolved_at || inc.resolution_notes) && (
                      <div className="mt-2 rounded border border-green-700/20 bg-green-900/10 px-2 py-1.5 text-[11px] text-green-300">
                        {inc.resolved_at ? `Resolved ${new Date(inc.resolved_at).toLocaleString()}` : 'Resolved'}
                        {inc.resolution_notes ? ` - ${inc.resolution_notes}` : ''}
                      </div>
                    )}
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <Dialog open={Boolean(resolveTarget)} onOpenChange={handleResolveDialogChange}>
        <DialogContent className="border-zinc-800 bg-mil-bg-deep text-white sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="text-sm font-semibold tracking-wider text-mil-fg">
              Resolve Incident
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <p className="text-sm text-mil-fg">{resolveTarget?.title || 'Untitled Incident'}</p>
              <p className="mt-1 text-xs text-mil-dim">
                Add optional resolution notes before marking this incident resolved.
              </p>
            </div>
            <Textarea
              value={resolutionNotes}
              onChange={(event) => setResolutionNotes(event.target.value)}
              placeholder="Resolution notes (optional)"
              className="min-h-[120px] border-zinc-800 bg-mil-bg-deep/60 text-sm text-white placeholder:text-mil-dim"
            />
            <div className="flex justify-end gap-2">
              <Button
                variant="outline"
                onClick={() => handleResolveDialogChange(false)}
                disabled={activeIncidentId === resolveTarget?.id}
                className="border-zinc-800 text-xs text-mil-muted"
              >
                Cancel
              </Button>
              <Button
                onClick={resolveIncident}
                disabled={activeIncidentId === resolveTarget?.id}
                className="bg-brand text-xs text-black hover:bg-brand-light"
              >
                {activeIncidentId === resolveTarget?.id ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : null}
                Resolve Incident
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export default IncidentsModule;
