import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useOutletContext } from 'react-router';
import {
  ArrowDown,
  CircleDashed,
  ExternalLink,
  FileCode2,
  Info,
  Loader2,
  PlayCircle,
  RefreshCw,
  TriangleAlert,
  Wrench,
} from 'lucide-react';
import apiClient from '@/lib/apiClient';
import { Button } from '@/components/ui/button';
import { toast } from '@/hooks/use-toast';
import { formatApiError } from '@/utils/errorMessages';
import { headingChild } from '@/utils/headingCase';

const TOP_ROWS = 10;
const WORKSHOP_URL = 'https://reforger.armaplatform.com/workshop/';

function Panel({ title, icon: Icon, action, children, className = '', bodyClassName = 'p-4' }) {
  return (
    <section className={`rounded-xl border border-white/[0.07] bg-mil-bg-panel/70 shadow-[0_1px_0_rgba(255,255,255,0.03)_inset] ${className}`}>
      {title ? (
        <header className="flex items-center justify-between gap-3 border-b border-white/[0.06] px-4 py-3">
          <h3 className="flex items-center gap-2 text-xs font-semibold text-mil-soft">
            {Icon ? <Icon className="h-3.5 w-3.5 text-brand" /> : null}
            {headingChild(title)}
          </h3>
          {action}
        </header>
      ) : null}
      <div className={bodyClassName}>{children}</div>
    </section>
  );
}

function SortHeader({ label, active, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-start justify-end gap-1 text-right uppercase ${active ? 'text-brand-light' : 'hover:text-mil-soft'}`}
    >
      {label}
      <ArrowDown className={`mt-px h-3 w-3 shrink-0 ${active ? 'opacity-100' : 'opacity-0'}`} />
    </button>
  );
}

function rowNote(row) {
  if (!row.downloaded) return 'Not downloaded yet';
  if (!row.listed && row.needed_by.length) {
    return `Dependency of ${row.needed_by.map((d) => d.name).join(', ')}`;
  }
  if (row.frees_mods > 1) {
    const others = row.frees_mods - 1;
    return `Also takes ${others} ${others === 1 ? 'mod' : 'mods'} with it`;
  }
  return '';
}

const GRID = 'grid grid-cols-[minmax(0,1fr)_4rem_6.5rem] items-start gap-x-3 sm:grid-cols-[minmax(0,1fr)_6rem_10rem]';

function BudgetRow({ row, max, total }) {
  const note = rowNote(row);
  const share = total ? (row.own / total) * 100 : 0;
  return (
    <div role="row" className={`${GRID} border-t border-white/[0.05] px-4 py-2.5 hover:bg-white/[0.02]`}>
      <div role="cell" className="min-w-0">
        <a
          href={`${WORKSHOP_URL}${row.mod_id}`}
          target="_blank"
          rel="noreferrer"
          className="group inline-flex max-w-full items-center gap-1 text-sm text-mil-fg hover:text-brand-light"
        >
          <span className="break-words sm:truncate">{row.name}</span>
          <ExternalLink className="h-3 w-3 shrink-0 opacity-0 group-hover:opacity-100" />
        </a>
        {note ? <p className="break-words text-[11px] text-mil-dim sm:truncate" title={note}>{note}</p> : null}
        <div className="mt-1.5 h-1 w-full max-w-[220px] overflow-hidden rounded-full bg-white/[0.05]" title={`${share.toFixed(1)}% of all script files`}>
          <div className="h-full rounded-full bg-brand/60" style={{ width: `${max ? (row.own / max) * 100 : 0}%` }} />
        </div>
      </div>
      <div role="cell" className="text-right font-mono text-sm tabular-nums text-mil-soft">{row.own}</div>
      <div role="cell" className="text-right font-mono text-sm tabular-nums text-mil-soft">{row.frees}</div>
    </div>
  );
}

function Stat({ label, value, hint }) {
  return (
    <div className="border-t border-white/[0.05] py-2 first:border-t-0 first:pt-0">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-xs text-mil-muted">{label}</span>
        <span className="font-mono text-sm tabular-nums text-mil-bright">{value}</span>
      </div>
      {hint ? <p className="mt-0.5 text-[11px] text-mil-dim">{hint}</p> : null}
    </div>
  );
}

const CHECK_TEXT = {
  starts: {
    tone: 'ok',
    title: 'This list starts',
    body: 'The unmodified game loaded every mod and initialised its scripts, so the server starts and players can join.',
  },
  over_call_target_limit: {
    tone: 'bad',
    title: 'Over the call-target limit',
    body: 'The mods together define more script functions than the game can address. Players crash when they join, even if the patched server starts. Take mods off and check again.',
  },
  compile_error: {
    tone: 'bad',
    title: 'Scripts do not compile',
    body: 'Two mods clash, or a mod is out of date for this game version. The server cannot start with this list.',
  },
  crashed: {
    tone: 'bad',
    title: 'The game crashed while loading scripts',
    body: 'Not the call-target limit. Start the server and read Crash Analysis for the cause.',
  },
  preparing: { tone: 'wait', title: 'Getting ready' },
  unavailable: { tone: 'wait', title: 'Cannot check yet' },
  unknown: { tone: 'wait', title: 'No clear result' },
};

const CHECK_TONE = {
  ok: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200',
  bad: 'border-red-500/30 bg-red-500/10 text-red-300',
  wait: 'border-white/10 bg-white/[0.03] text-mil-soft',
};

function PrelaunchCheck({ result, busy, canManage, onCheck }) {
  const text = result ? CHECK_TEXT[result.verdict] || CHECK_TEXT.unknown : null;
  return (
    <Panel title="Will this list start?" icon={PlayCircle}>
      <p className="text-xs leading-relaxed text-mil-muted">
        Loads the saved mod list in the unmodified game, off to the side, and reports whether its scripts start.
        It takes about ten seconds and does not touch the running server.
      </p>
      {result ? (
        <div className={`mt-3 rounded-md border px-3 py-2 text-xs leading-relaxed ${CHECK_TONE[text.tone]}`} role="status">
          <p className="font-semibold">{text.title}</p>
          <p className="mt-1">{text.body || result.reason}</p>
          {result.errors?.length ? (
            <ul className="mt-2 space-y-1 font-mono text-[11px]">
              {result.errors.map((line) => <li key={line} className="break-words">{line}</li>)}
            </ul>
          ) : null}
          {result.missing?.length ? (
            <p className="mt-2">Not downloaded: {result.missing.join(', ')}{result.missing_count > result.missing.length ? ' and more' : ''}</p>
          ) : null}
          {result.checked_mods ? (
            <p className="mt-2 text-[11px] opacity-80">{result.checked_mods} mods checked in {result.seconds} s</p>
          ) : null}
        </div>
      ) : null}
      {canManage ? (
        <Button variant="outline" size="sm" className="mt-3 w-full gap-2" disabled={busy} onClick={onCheck}>
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <PlayCircle className="h-3.5 w-3.5" />}
          {busy ? 'Checking…' : 'Check this list'}
        </Button>
      ) : null}
    </Panel>
  );
}

function CallTargetLimit({ limit, canManage, busy, onSet }) {
  const { patch_enabled: on, hit } = limit;
  const stock = limit.stock_limit.toLocaleString();
  const raised = limit.patched_limit.toLocaleString();
  const overRaised = hit && on;
  return (
    <Panel title="Call-target limit" icon={hit ? TriangleAlert : Wrench}>
      <Stat label="Limit on this server" value={limit.limit.toLocaleString()} hint={on ? 'Raised by the server patch' : 'Stock engine limit'} />
      <div className="mt-3 space-y-2 text-xs leading-relaxed text-mil-muted">
        {hit && !on ? (
          <p className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-amber-200">
            The last start crashed at this limit (NULL pointer in #InitGlobals). The mods together define more
            than {stock} call targets.
          </p>
        ) : null}
        {overRaised ? (
          <p className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-red-300">
            The last start still crashed with the patch on. Either the list is past {raised} call targets, or the
            patch did not fit this game version (the server log says which). Take mods off.
          </p>
        ) : null}
        <p>
          The engine can address {stock} script functions across the game and every mod. The patch starts the
          server on a modified copy of its program that can address {raised}. It is one fixed step, not a
          dial, and it switches itself off if a game update changes the code it edits.
        </p>
      </div>
      {canManage ? (
        <Button
          variant={hit && !on ? 'default' : 'outline'}
          size="sm"
          className="mt-3 w-full gap-2"
          disabled={busy}
          onClick={() => onSet(!on)}
        >
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Wrench className="h-3.5 w-3.5" />}
          {on ? 'Turn the patch off and restart' : 'Raise the limit and restart'}
        </Button>
      ) : null}
    </Panel>
  );
}

function ScriptBudgetModule() {
  const { serverId, canManage, fetchServer } = useOutletContext();
  const [limitBusy, setLimitBusy] = useState(false);
  const [check, setCheck] = useState(null);
  const [checkBusy, setCheckBusy] = useState(false);

  const runCheck = async () => {
    setCheckBusy(true);
    try {
      const res = await apiClient.post(`/servers/${serverId}/script-budget/check`, {}, { timeout: 240000 });
      setCheck(res.data);
    } catch (err) {
      setCheck({ verdict: 'unknown', reason: formatApiError(err, 'The check did not finish.') });
    } finally {
      setCheckBusy(false);
    }
  };
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [sortKey, setSortKey] = useState('own');
  const [showAll, setShowAll] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiClient.get(`/servers/${serverId}/script-budget`);
      setData(res.data);
      setError('');
    } catch (err) {
      setError(formatApiError(err, 'The script budget failed to load.'));
    } finally {
      setLoading(false);
    }
  }, [serverId]);

  useEffect(() => { load(); }, [load]);

  const setLimitPatch = async (enabled) => {
    setLimitBusy(true);
    try {
      const res = await apiClient.post(
        `/servers/${serverId}/script-limit`,
        { enabled, restart: true },
        { validateStatus: (status) => status < 400 },
      );
      const restartError = res.data?.restart?.error;
      let note = 'The server is restarting.';
      if (restartError) note = `Saved, but the restart failed: ${restartError}`;
      toast({ title: enabled ? 'Limit raised' : 'Patch turned off', description: note });
      fetchServer?.(true);
      await load();
    } catch (err) {
      toast({
        title: 'Not changed',
        description: formatApiError(err, err.message || 'The server refused the change.'),
        variant: 'destructive',
      });
    } finally {
      setLimitBusy(false);
    }
  };

  const mods = data?.mods || [];
  const total = data?.total_scripts || 0;
  const sorted = useMemo(
    () => [...mods].sort((a, b) => b[sortKey] - a[sortKey] || a.name.localeCompare(b.name)),
    [mods, sortKey],
  );
  const visible = showAll ? sorted : sorted.slice(0, TOP_ROWS);
  const max = mods.reduce((m, row) => Math.max(m, row.own), 0);
  const topShare = total
    ? Math.round((mods.slice(0, TOP_ROWS).reduce((sum, row) => sum + row.own, 0) / total) * 100)
    : 0;

  if (loading && !data) {
    return (
      <div className="flex items-center justify-center gap-2 py-24 text-sm text-mil-muted">
        <Loader2 className="h-4 w-4 animate-spin" /> Counting each mod's script files…
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 className="flex items-center gap-2 text-xl font-semibold text-brand-light">
            <FileCode2 className="h-5 w-5" /> Script Budget
          </h2>
          <p className="mt-1 max-w-2xl text-xs leading-relaxed text-mil-dim">
            How many script files each mod on this server loads, read from the downloaded mods. Hosting
            panels rank mods by this number. Taking a mod off frees its own scripts, plus any dependency
            no other mod still needs.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={load} disabled={loading} className="gap-2 self-start sm:self-auto">
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} /> Recount
        </Button>
      </div>

      {error ? (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">{error}</div>
      ) : null}

      {data && !mods.length ? (
        <Panel>
          <div className="flex flex-col items-center gap-2 py-10 text-center text-sm text-mil-muted">
            <CircleDashed className="h-6 w-6 text-mil-dim/70" />
            No mods in this server's list yet.
          </div>
        </Panel>
      ) : null}

      {mods.length ? (
        <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_300px]">
          <Panel title="Script files by mod" icon={FileCode2} bodyClassName="">
            <div role="table" aria-label="Script files by mod">
              <div role="row" className={`${GRID} px-4 py-2.5 font-mono text-[10px] uppercase tracking-[0.14em] text-mil-dim`}>
                <span role="columnheader">Mod</span>
                <span role="columnheader" className="text-right">
                  <SortHeader label="Own" active={sortKey === 'own'} onClick={() => setSortKey('own')} />
                </span>
                <span role="columnheader" className="text-right">
                  <SortHeader label="Taking it off frees" active={sortKey === 'frees'} onClick={() => setSortKey('frees')} />
                </span>
              </div>
              {visible.map((row) => (
                <BudgetRow key={row.mod_id} row={row} max={max} total={total} />
              ))}
            </div>
            {sorted.length > TOP_ROWS ? (
              <div className="border-t border-white/[0.06] px-4 py-3">
                <button
                  type="button"
                  onClick={() => setShowAll((value) => !value)}
                  className="text-xs text-mil-soft hover:text-brand-light"
                >
                  {showAll ? `Show top ${TOP_ROWS}` : `Show all ${sorted.length}`}
                </button>
              </div>
            ) : null}
          </Panel>

          <aside className="min-w-0 space-y-5">
            <PrelaunchCheck result={check} busy={checkBusy} canManage={canManage !== false} onCheck={runCheck} />
            {data.call_target_limit ? (
              <CallTargetLimit
                limit={data.call_target_limit}
                canManage={canManage !== false}
                busy={limitBusy}
                onSet={setLimitPatch}
              />
            ) : null}
            <Panel title="This server">
              <Stat label="Script files loaded" value={total.toLocaleString()} />
              <Stat
                label="Mods loaded"
                value={data.loaded_count}
                hint={`${data.listed_count} in the list, ${data.dependency_count} pulled in as dependencies`}
              />
              <Stat label={`Top ${TOP_ROWS} mods' share`} value={`${topShare}%`} />
              {data.missing_count ? (
                <Stat label="Not downloaded yet" value={data.missing_count} hint="Counted as 0 until the server downloads them" />
              ) : null}
            </Panel>
            <Panel title="What this counts" icon={Info}>
              <div className="space-y-2 text-xs leading-relaxed text-mil-muted">
                <p>
                  <span className="text-mil-soft">Own</span> is the number of script files (.c) packed in the mod.
                  Only mods the list loads are counted; leftover folders on disk are not loaded, so they are left out.
                </p>
                <p>
                  <span className="text-mil-soft">Taking it off frees</span> adds the dependencies that would stop
                  loading with it. For a dependency, it includes the listed mods that need it, since they cannot stay
                  without it.
                </p>
                <p>
                  A file count shows how big a mod's code is, not what a server can hold. Big mod lists fail at
                  start-up on engine limits this page cannot count ahead of time; it reports the call-target
                  limit once a start has crashed on it.
                </p>
              </div>
            </Panel>
          </aside>
        </div>
      ) : null}
    </div>
  );
}

export default ScriptBudgetModule;
