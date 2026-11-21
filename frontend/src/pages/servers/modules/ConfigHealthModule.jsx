import React from 'react';
import { useOutletContext, Link } from 'react-router';
import { FileSearch, Loader2, RefreshCw, Settings, ShieldCheck } from 'lucide-react';
import { useApiQuery } from '@/hooks/useApiQuery';
import { formatApiError } from '@/utils/errorMessages';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { CheckList, ConfigStateBadge, DriftTable, FindingsList, LintCounts, ScoreRing, VerdictBadge } from '@/components/servers/health/HealthParts';

// Per-server Config Health report: the status checks, where the
// config file is and whether it matches the saved config, and every config
// rule it breaks.

function Row({ label, children }) {
  return (
    <div className="flex items-start justify-between gap-4 text-xs">
      <span className="text-mil-dim">{label}</span>
      <span className="min-w-0 break-all text-right text-mil-muted">{children}</span>
    </div>
  );
}

export default function ConfigHealthModule() {
  const { serverId } = useOutletContext();
  const { data, isLoading, isFetching, error, refetch } = useApiQuery(`/config-health/servers/${serverId}`, {
    refetchInterval: 30_000,
  });

  if (isLoading) {
    return <div className="flex items-center justify-center py-16"><Loader2 className="h-6 w-6 animate-spin text-brand" /></div>;
  }
  if (error) {
    return <div className="border border-red-600/30 bg-red-600/10 px-3 py-2 text-xs text-red-300">{formatApiError(error, 'Could not load the config health report.')}</div>;
  }

  const { status, config } = data;
  const detection = config.detection || {};
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <ScoreRing score={status.score} overall={status.overall} size={64} />
          <div>
            <h2 className="flex items-center gap-2 text-sm font-semibold tracking-wider text-mil-muted" style={{ fontFamily: 'var(--font-heading)' }}>
              <ShieldCheck className="h-4 w-4 text-brand" /> Config Health
            </h2>
            <p className="mt-1 text-xs text-mil-dim">{status.headline}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <VerdictBadge overall={status.overall} />
          <button type="button" onClick={() => refetch()} className="flex h-7 items-center gap-1.5 border border-zinc-800 px-2.5 text-xs text-mil-muted hover:text-brand">
            {isFetching ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />} Re-check
          </button>
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card className="border-zinc-800 bg-mil-bg-deep/60">
          <CardHeader className="pb-2"><CardTitle className="text-xs uppercase tracking-widest text-mil-muted">Status checks</CardTitle></CardHeader>
          <CardContent><CheckList checks={status.checks} /></CardContent>
        </Card>

        <Card className="border-zinc-800 bg-mil-bg-deep/60">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-xs uppercase tracking-widest text-mil-muted">
              <FileSearch className="h-3.5 w-3.5 text-brand" /> Config file detection
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <Row label="State"><ConfigStateBadge state={config.state} driftCount={config.drift_count} /></Row>
            <Row label="Path"><code>{detection.path || '-'}</code></Row>
            <Row label="Last written">{detection.modified_at ? new Date(detection.modified_at).toLocaleString() : '-'}</Row>
            <Row label="Size">{detection.size_bytes != null ? `${detection.size_bytes.toLocaleString()} bytes` : '-'}</Row>
            {detection.parse_error ? <Row label="Parse error"><span className="text-red-300">{detection.parse_error}</span></Row> : null}
            <p className="pt-1 text-xs text-mil-fg">{detection.message}</p>
          </CardContent>
        </Card>
      </div>

      {detection.drift?.length ? (
        <Card className="border-amber-600/30 bg-mil-bg-deep/60">
          <CardHeader className="pb-2">
            <CardTitle className="text-xs uppercase tracking-widest text-amber-300">Drift: saved config vs file on disk</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-xs text-mil-dim">
              The engine reads the file on disk. If the saved config is right, apply it from{' '}
              <Link to="../config/server" relative="path" className="text-brand hover:underline">Server Config</Link>{' '}
              (Reconfigure) so the next start uses it. Password fields only show whether they are set.
            </p>
            <DriftTable drift={detection.drift} />
          </CardContent>
        </Card>
      ) : null}

      <Card className="border-zinc-800 bg-mil-bg-deep/60">
        <CardHeader className="flex flex-row items-center justify-between pb-2">
          <CardTitle className="text-xs uppercase tracking-widest text-mil-muted">Config rules</CardTitle>
          <LintCounts counts={config.lint} />
        </CardHeader>
        <CardContent className="space-y-3">
          <FindingsList findings={config.findings} empty="The config passes every rule." />
          <Link to="../config/server" relative="path" className="inline-flex items-center gap-1.5 text-xs text-brand hover:underline">
            <Settings className="h-3 w-3" /> Edit in Server Config
          </Link>
        </CardContent>
      </Card>
    </div>
  );
}
