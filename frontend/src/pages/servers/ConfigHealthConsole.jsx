import React from 'react';
import { Link } from 'react-router';
import { Activity, ArrowUpRight, Loader2, Puzzle, RefreshCw, ShieldCheck, Users } from 'lucide-react';
import { useApiQuery } from '@/hooks/useApiQuery';
import { formatApiError } from '@/utils/errorMessages';
import { CheckList, ConfigStateBadge, LintCounts, ScoreRing, VERDICTS, VerdictBadge } from '@/components/servers/health/HealthParts';

// Config Health: the fleet at a glance. One card per server with
// a single verdict, the checks behind it, and the state of its config file.

function Stat({ label, value, tone = 'text-mil-fg' }) {
  return (
    <div className="min-w-24 border border-[rgba(232,131,58,0.1)] bg-mil-bg-panel/70 px-3 py-2">
      <p className="text-[10px] uppercase tracking-widest text-mil-dim" style={{ fontFamily: 'var(--font-condensed)' }}>{label}</p>
      <p className={`text-xl font-semibold ${tone}`} style={{ fontFamily: 'var(--font-mono)' }}>{value}</p>
    </div>
  );
}

function ServerTile({ server }) {
  const { status, config } = server;
  const accent = VERDICTS[status.overall]?.ring || '#71717a';
  return (
    <article className="relative flex flex-col gap-3 border border-[rgba(232,131,58,0.14)] bg-mil-bg-deep/88 p-4 transition-colors hover:border-brand/35">
      <span className="absolute inset-y-0 left-0 w-0.5" style={{ background: accent }} aria-hidden="true" />
      <header className="flex items-start gap-3">
        <ScoreRing score={status.score} overall={status.overall} />
        <div className="min-w-0 flex-1">
          <Link to={`/servers/${server.id}`} className="group inline-flex max-w-full items-center gap-1">
            <h3 className="truncate text-base font-semibold text-brand-light group-hover:text-brand" style={{ fontFamily: 'var(--font-heading)' }}>
              {server.name}
            </h3>
            <ArrowUpRight className="h-3.5 w-3.5 shrink-0 text-mil-dim group-hover:text-brand" />
          </Link>
          <p className="mt-0.5 truncate text-xs text-mil-dim" title={status.headline}>{status.headline}</p>
        </div>
        <VerdictBadge overall={status.overall} />
      </header>

      <div className="grid grid-cols-3 gap-2 text-xs">
        <div className="flex items-center gap-1.5 text-mil-muted" title="Players from the Steam query">
          <Users className="h-3.5 w-3.5 text-brand" />
          <span className="font-mono text-mil-fg">{server.players ?? '-'}</span>/{server.max_players ?? '-'}
        </div>
        <div className="flex items-center gap-1.5 text-mil-muted">
          <Puzzle className="h-3.5 w-3.5 text-brand" />
          <span className="font-mono text-mil-fg">{server.mod_count}</span> mods
        </div>
        <div className="truncate text-right font-mono text-[11px] text-mil-dim" title="Game / query / RCON ports">
          {server.ports.game}/{server.ports.query}/{server.ports.rcon}
        </div>
      </div>
      {server.map ? <p className="-mt-1 truncate text-[11px] text-mil-dim" title={server.scenario}>Map: {server.map}</p> : null}

      <div className="flex items-center justify-between border-y border-zinc-800/80 py-2">
        <ConfigStateBadge state={config.state} driftCount={config.drift_count} />
        <LintCounts counts={config.lint} />
        <Link to={`/servers/${server.id}/config/health`} className="text-xs text-brand hover:text-brand-light">
          Config health
        </Link>
      </div>

      <CheckList checks={status.checks} compact />
    </article>
  );
}

export default function ConfigHealthConsole() {
  const { data, isLoading, isFetching, error, refetch, dataUpdatedAt } = useApiQuery('/config-health/fleet', {
    refetchInterval: 20_000,
  });

  if (isLoading) {
    return <div className="flex items-center justify-center py-16"><Loader2 className="h-6 w-6 animate-spin text-brand" /></div>;
  }
  if (error) {
    return <div className="border border-red-600/30 bg-red-600/10 px-3 py-2 text-xs text-red-300">{formatApiError(error, 'Could not load the fleet health report.')}</div>;
  }

  const totals = data?.totals || {};
  const servers = data?.servers || [];
  return (
    <div className="space-y-5">
      <section className="flex flex-wrap items-end justify-between gap-4 border border-[rgba(232,131,58,0.14)] bg-[linear-gradient(120deg,rgba(232,131,58,0.07),transparent_60%)] p-4">
        <div>
          <p className="flex items-center gap-2 text-[11px] uppercase tracking-[0.25em] text-brand" style={{ fontFamily: 'var(--font-condensed)' }}>
            <ShieldCheck className="h-3.5 w-3.5" /> Reforger fleet
          </p>
          <h2 className="mt-1 text-xl font-semibold text-brand-light" style={{ fontFamily: 'var(--font-heading)' }}>
            Config Health
          </h2>
          <p className="mt-1 max-w-xl text-xs text-mil-dim">
            Every server checked live: container, panel state, Steam query, incidents, the config file on disk and the config rules.
            Refreshes every 20 seconds.
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <Stat label="Online" value={totals.online || 0} tone="text-emerald-300" />
          <Stat label="Degraded" value={totals.degraded || 0} tone={totals.degraded ? 'text-amber-300' : 'text-mil-fg'} />
          <Stat label="Down" value={totals.down || 0} tone={totals.down ? 'text-red-300' : 'text-mil-fg'} />
          <Stat label="Stopped" value={totals.stopped || 0} />
          <Stat label="Players" value={data?.players ?? 0} tone="text-brand-light" />
          <button type="button" onClick={() => refetch()} className="flex h-[58px] items-center gap-1.5 border border-zinc-800 px-3 text-xs text-mil-muted hover:border-brand/40 hover:text-brand" title={dataUpdatedAt ? `Updated ${new Date(dataUpdatedAt).toLocaleTimeString()}` : ''}>
            {isFetching ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />} Refresh
          </button>
        </div>
      </section>

      {servers.length ? (
        <div className="grid gap-4 lg:grid-cols-2">
          {servers.map((server) => <ServerTile key={server.id} server={server} />)}
        </div>
      ) : (
        <p className="flex items-center gap-2 text-xs text-mil-dim"><Activity className="h-4 w-4" /> No managed servers yet.</p>
      )}
    </div>
  );
}
