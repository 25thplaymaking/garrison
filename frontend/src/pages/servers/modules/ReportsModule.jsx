import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { Link, useOutletContext } from 'react-router';
import apiClient from '@/lib/apiClient';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Activity,
  AlertTriangle,
  Download,
  FileText,
  Loader2,
  RefreshCw,
  ShieldCheck,
  StickyNote,
} from 'lucide-react';
import { formatApiError } from '@/utils/errorMessages';
function humanize(value) {
  if (!value) return 'Unclassified';
  return String(value)
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function formatDate(value) {
  if (!value) return 'Unknown';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Unknown' : date.toLocaleString();
}

function severityTone(severity) {
  return {
    low: 'border-zinc-700 text-zinc-300',
    medium: 'border-blue-600/30 text-blue-300',
    high: 'border-amber-600/30 text-amber-300',
    critical: 'border-red-600/30 text-red-300',
  }[severity] || 'border-zinc-700 text-zinc-300';
}

function SummaryCard({ label, value, detail, icon: Icon, color, border }) {
  return (
    <Card className={`${border} bg-mil-bg-deep/60`}>
      <CardContent className="p-3">
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium text-mil-muted capitalize">{label}</span>
          <Icon className={`h-3.5 w-3.5 ${color}`} />
        </div>
        <div className="mt-1.5 text-xl font-bold text-white" style={{ fontFamily: "var(--font-heading)" }}>
          {value}
        </div>
        {detail ? <div className="mt-1 text-[11px] text-mil-dim">{detail}</div> : null}
      </CardContent>
    </Card>
  );
}

function BreakdownCard({ title, items, emptyLabel, accent = 'text-mil-muted' }) {
  return (
    <Card className="border-zinc-800 bg-mil-bg-deep/60">
      <CardHeader className="pb-2">
        <CardTitle className="text-xs font-semibold tracking-wider text-mil-muted">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        {items.length === 0 ? (
          <p className="py-4 text-center text-xs text-mil-dim">{emptyLabel}</p>
        ) : (
          <div className="space-y-2">
            {items.map((item) => (
              <div key={item.label} className="flex items-center justify-between rounded border border-zinc-800/70 bg-zinc-950/70 px-3 py-2 text-xs">
                <span className="text-mil-muted">{item.label}</span>
                <Badge variant="outline" className={`border-zinc-700 ${item.className || accent}`}>
                  {item.value}
                </Badge>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function SourceLinkCard({ title, description, to, metric, icon: Icon, tone = 'text-mil-muted' }) {
  return (
    <Link
      to={to}
      className="group block rounded border border-zinc-800 bg-mil-bg-deep/60 p-4 transition-colors hover:border-[rgba(232,131,58,0.28)] hover:bg-mil-bg-panel"
    >
      <div className="flex items-start gap-3">
        <Icon className={`mt-0.5 h-4 w-4 ${tone}`} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs font-medium text-mil-muted group-hover:text-mil-fg capitalize">{title}</span>
            <Badge variant="outline" className="border-zinc-700 text-[11px] text-mil-muted">{metric}</Badge>
          </div>
          <p className="mt-2 text-xs leading-relaxed text-mil-dim">{description}</p>
        </div>
      </div>
    </Link>
  );
}

function ReportsModule() {
  const { serverId } = useOutletContext();
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [fetchError, setFetchError] = useState(null);

  const fetchData = useCallback(async (silent = false) => {
    if (silent) setRefreshing(true);
    else setLoading(true);

    setFetchError(null);
    try {
      const res = await apiClient.get(`/servers/${serverId}/reports/summary`);
      setReport(res.data);
    } catch (err) {
      setFetchError(formatApiError(err, 'Failed to load report.'));
      // Keep the last good report on a failed refresh; with none, leave it
      // null so the retry screen shows instead of a page of zeros.
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [serverId]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  useEffect(() => {
    const intervalId = setInterval(() => {
      fetchData(true);
    }, 30_000);
    return () => clearInterval(intervalId);
  }, [fetchData]);

  const exportReport = useCallback(() => {
    const payload = {
      generated_at: new Date().toISOString(),
      ...report,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `server-report-${serverId}-${new Date().toISOString().slice(0, 10)}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  }, [report, serverId]);

  const summary = report?.summary || {};
  const backups = report?.backups || [];
  const modIssues = report?.mod_issues || [];
  const workspacePath = `/servers/${serverId}`;

  const modIssueCount = useMemo(() => {
    const categories = summary.mod_issue_categories || {};
    return Object.values(categories).reduce((total, count) => total + Number(count || 0), 0);
  }, [summary]);

  const detectionCategoryItems = useMemo(
    () =>
      Object.entries(summary.detection_categories || {})
        .sort((a, b) => Number(b[1]) - Number(a[1]))
        .map(([category, count]) => ({ label: humanize(category), value: count })),
    [summary],
  );

  const detectionSeverityItems = useMemo(
    () =>
      Object.entries(summary.detection_severity || {})
        .sort((a, b) => Number(b[1]) - Number(a[1]))
        .map(([severity, count]) => ({
          label: humanize(severity),
          value: count,
          className: severityTone(severity),
        })),
    [summary],
  );

  const modIssueItems = useMemo(
    () =>
      Object.entries(summary.mod_issue_categories || {})
        .sort((a, b) => Number(b[1]) - Number(a[1]))
        .map(([category, count]) => ({ label: humanize(category), value: count, className: 'text-amber-300' })),
    [summary],
  );

  const noteCategoryItems = useMemo(
    () =>
      Object.entries(summary.notes?.by_category || {})
        .sort((a, b) => Number(b[1]) - Number(a[1]))
        .map(([category, count]) => ({ label: humanize(category), value: count })),
    [summary],
  );

  const activeAlerts = (summary.detections?.active || 0) + (summary.incidents?.open || 0);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="h-5 w-5 animate-spin text-brand" />
      </div>
    );
  }

  if (fetchError && !report) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-16">
        <AlertTriangle className="h-5 w-5 text-red-400" />
        <p className="text-xs text-red-400">{fetchError}</p>
        <Button size="sm" variant="outline" onClick={() => fetchData()} className="h-7 border-zinc-800 text-xs text-mil-muted">
          <RefreshCw className="mr-1 h-3 w-3" /> Retry
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold tracking-wider text-mil-muted" style={{ fontFamily: "var(--font-heading)" }}>
            Reports
          </h2>
          <p className="mt-1 text-xs text-mil-dim">
            Read-only server health summary for exports, backup history, and links back to the source operating modules.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Badge variant="outline" className="border-zinc-800 text-[11px] text-mil-muted">
            Refreshes every 30s
          </Badge>
          <Button size="sm" variant="outline" onClick={() => fetchData(true)} className="h-7 border-zinc-800 text-xs text-mil-muted">
            <RefreshCw className={`mr-1 h-3 w-3 ${refreshing ? 'animate-spin' : ''}`} /> Refresh
          </Button>
          <Button size="sm" onClick={exportReport} disabled={!report || Object.keys(report).length === 0} className="h-7 bg-brand text-black hover:bg-brand-light text-xs disabled:opacity-50">
            <Download className="mr-1 h-3 w-3" /> Export
          </Button>
        </div>
      </div>

      {fetchError ? (
        <div className="rounded border border-red-600/30 bg-red-600/10 px-3 py-2 text-xs text-red-400">
          {fetchError}
        </div>
      ) : null}

      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <SummaryCard
          label="Active Alerts"
          value={activeAlerts}
          detail={`${summary.detections?.active || 0} live detections, ${summary.incidents?.open || 0} open incidents`}
          icon={AlertTriangle}
          color="text-red-400"
          border="border-red-600/20"
        />
        <SummaryCard
          label="Watcher Coverage"
          value={`${summary.watchers?.enabled || 0}/${summary.watchers?.total || 0}`}
          detail={`${summary.watchers?.system_managed || 0} essential watchers installed`}
          icon={ShieldCheck}
          color="text-blue-400"
          border="border-blue-600/20"
        />
        <SummaryCard
          label="Ops Notes"
          value={summary.notes?.open || 0}
          detail={`${summary.notes?.follow_up_required || 0} require follow-up`}
          icon={StickyNote}
          color="text-amber-300"
          border="border-amber-600/20"
        />
        <SummaryCard
          label="Backups"
          value={summary.backups || 0}
          detail={`${backups.length} recent backups in report history`}
          icon={Download}
          color="text-green-400"
          border="border-green-600/20"
        />
      </div>

      <div className="grid gap-4 xl:grid-cols-3">
        <BreakdownCard
          title="DETECTION CATEGORIES"
          items={detectionCategoryItems}
          emptyLabel="No detections have been categorized yet."
          accent="text-blue-300"
        />
        <BreakdownCard
          title="SEVERITY MIX"
          items={detectionSeverityItems}
          emptyLabel="No detection severity data yet."
        />
        <BreakdownCard
          title="MOD ISSUE ATTRIBUTION"
          items={modIssueItems}
          emptyLabel="No mod issues have been attributed to this server yet."
          accent="text-amber-300"
        />
      </div>

      <div className="grid gap-4 xl:grid-cols-3">
        <Card className="border-zinc-800 bg-mil-bg-deep/60">
          <CardHeader className="pb-2">
            <CardTitle className="text-xs font-semibold tracking-wider text-mil-muted">OPS LOG SUMMARY</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="rounded border border-zinc-800/70 bg-zinc-950/70 px-3 py-2">
                <div className="text-xs text-mil-muted font-medium">Total</div>
                <div className="mt-1 text-lg font-semibold text-white">{summary.notes?.total || 0}</div>
              </div>
              <div className="rounded border border-zinc-800/70 bg-zinc-950/70 px-3 py-2">
                <div className="text-xs text-mil-muted font-medium">Open</div>
                <div className="mt-1 text-lg font-semibold text-white">{summary.notes?.open || 0}</div>
              </div>
              <div className="rounded border border-zinc-800/70 bg-zinc-950/70 px-3 py-2">
                <div className="text-xs text-mil-muted font-medium">Follow-Up</div>
                <div className="mt-1 text-lg font-semibold text-white">{summary.notes?.follow_up_required || 0}</div>
              </div>
            </div>

            <BreakdownCard
              title="NOTE CATEGORIES"
              items={noteCategoryItems}
              emptyLabel="No categorized notes yet."
            />
          </CardContent>
        </Card>

        <Card className="border-zinc-800 bg-mil-bg-deep/60">
          <CardHeader className="pb-2">
            <CardTitle className="text-xs font-semibold tracking-wider text-mil-muted">BACKUP HISTORY</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {backups.length === 0 ? (
              <p className="py-8 text-center text-xs text-mil-dim">No backups created in the current report window.</p>
            ) : backups.slice(0, 5).map((backup, index) => (
              <div key={backup.id || index} className="rounded border border-zinc-800/70 bg-zinc-950/70 px-3 py-2">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-sm text-mil-fg">{humanize(backup.backup_type || 'Backup')}</span>
                  <Badge variant="outline" className="border-zinc-700 text-[11px] text-mil-muted">
                    {Array.isArray(backup.mods_snapshot) ? `${backup.mods_snapshot.length} mods` : 'config snapshot'}
                  </Badge>
                </div>
                <div className="mt-1 text-[11px] text-mil-dim">
                  {backup.created_at ? formatDate(backup.created_at) : 'Unknown time'}
                </div>
              </div>
            ))}
          </CardContent>
        </Card>

        <Card className="border-zinc-800 bg-mil-bg-deep/60">
          <CardHeader className="pb-2">
            <CardTitle className="text-xs font-semibold tracking-wider text-mil-muted">REPORT SOURCES</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <SourceLinkCard
              title="Health & Alerts"
              to={`${workspacePath}/tools/watchers?tab=watchers`}
              metric={`${summary.detections?.active || 0} active`}
              description="Open watcher detections, active notifications, and alert verdict changes."
              icon={ShieldCheck}
              tone="text-blue-300"
            />
            <SourceLinkCard
              title="Incidents"
              to={`${workspacePath}/tools/watchers?tab=incidents`}
              metric={`${summary.incidents?.open || 0} open`}
              description="Formal troubleshooting cases, resolution work, and post-incident context."
              icon={Activity}
              tone="text-red-300"
            />
            <SourceLinkCard
              title="Ops Log"
              to={`${workspacePath}/admin/notes`}
              metric={`${summary.notes?.follow_up_required || 0} follow-up`}
              description="Structured notes, handoffs, requested actions, and lightweight tasks."
              icon={StickyNote}
              tone="text-amber-300"
            />
          </CardContent>
        </Card>
      </div>

      {modIssues.length > 0 ? (
        <Card className="border-zinc-800 bg-mil-bg-deep/60">
          <CardHeader className="pb-2">
            <CardTitle className="text-xs font-semibold tracking-wider text-mil-muted">MOD FINDINGS SUMMARY</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap items-center gap-3 text-xs text-mil-muted">
              <Badge variant="outline" className="border-amber-600/30 text-amber-300">
                {modIssueCount || modIssues.length} attributed findings
              </Badge>
              <span>
                Mod issue details now stay in Mods and Health & Alerts; reports keep only the exportable count and category mix.
              </span>
              <Link to={`${workspacePath}/mods`} className="ml-auto text-brand hover:text-brand-light">
                Open Mods
              </Link>
            </div>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

export default ReportsModule;
