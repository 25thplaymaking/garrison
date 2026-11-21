import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useOutletContext } from 'react-router';
import {
  AlertOctagon,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleDashed,
  ExternalLink,
  FileWarning,
  History,
  Info,
  Loader2,
  Pin,
  Plus,
  RefreshCw,
  RotateCcw,
  Settings,
  Square,
  Stethoscope,
  Trash2,
  Wrench,
} from 'lucide-react';
import apiClient from '@/lib/apiClient';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { toast } from '@/hooks/use-toast';
import { formatApiError } from '@/utils/errorMessages';
import { headingChild } from '@/utils/headingCase';

const OUTCOME = {
  failed_to_start: { label: 'Failed to start', tone: 'critical' },
  crashed_runtime: { label: 'Crashed while running', tone: 'critical' },
  ended_unexpectedly: { label: 'Interrupted', tone: 'warn' },
  running: { label: 'Running', tone: 'ok' },
  starting: { label: 'Starting', tone: 'warn' },
  downloading: { label: 'Downloading mods', tone: 'warn' },
  stopped: { label: 'Stopped', tone: 'muted' },
};

const TONE = {
  critical: 'border-red-500/40 bg-red-500/10 text-red-300',
  warn: 'border-amber-500/40 bg-amber-500/10 text-amber-300',
  ok: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300',
  muted: 'border-mil-muted/30 bg-mil-muted/10 text-mil-soft',
};

const DOT = {
  critical: 'bg-red-400',
  warn: 'bg-amber-400',
  ok: 'bg-emerald-400',
  muted: 'bg-mil-dim',
};

const ROLE_LABEL = {
  script: 'Owns the failing script',
  content: 'Ships the broken asset',
  scenario: 'Ships the configured scenario',
  unavailable: "Can't be downloaded",
  download: 'Was downloading',
};

const ACTION_ICON = {
  remove_mods: Trash2,
  add_mods: Plus,
  pin_version: Pin,
  delete_addon: Trash2,
  revert_revision: RotateCcw,
  restart: RefreshCw,
  stop: Square,
  open_settings: Settings,
};

function sessionTime(session) {
  const match = /^logs_(\d{4}-\d{2}-\d{2})_(\d{2})-(\d{2})-(\d{2})$/.exec(session || '');
  if (!match) return session || '';
  const date = new Date(`${match[1]}T${match[2]}:${match[3]}:${match[4]}Z`);
  return date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function OutcomeBadge({ outcome }) {
  const meta = OUTCOME[outcome] || { label: outcome || 'Unknown', tone: 'muted' };
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-medium ${TONE[meta.tone]}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${DOT[meta.tone]}`} />
      {meta.label}
    </span>
  );
}

function Panel({ title, icon: Icon, action, children, className = '' }) {
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
      <div className="p-4">{children}</div>
    </section>
  );
}

function EvidenceBlock({ evidence }) {
  if (!evidence) return null;
  const lines = evidence.context?.length ? evidence.context : [{ line: evidence.line, text: evidence.text, focus: true }];
  return (
    <figure className="overflow-hidden rounded-lg border border-white/[0.06] bg-black/40">
      <figcaption className="flex items-center justify-between border-b border-white/[0.06] px-3 py-1.5 font-mono text-[11px] text-mil-dim">
        <span>{evidence.file}{evidence.line ? `:${evidence.line}` : ''}</span>
      </figcaption>
      <pre className="max-h-72 overflow-auto py-2 text-[11.5px] leading-relaxed">
        {lines.map((row, index) => (
          <div
            key={`${row.line ?? 'x'}-${index}`}
            className={`flex gap-3 px-3 ${row.focus ? 'bg-red-500/10 text-red-200' : 'text-mil-muted'}`}
          >
            <span className="w-12 shrink-0 select-none text-right text-mil-dim/60">{row.line ?? ''}</span>
            <code className="whitespace-pre-wrap break-all">{row.text || ' '}</code>
          </div>
        ))}
      </pre>
    </figure>
  );
}

function FindingRow({ finding, defaultOpen = false }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <li className="rounded-lg border border-white/[0.06] bg-mil-bg-deep/50">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-start gap-2 px-3 py-2.5 text-left"
      >
        {open ? <ChevronDown className="mt-0.5 h-4 w-4 shrink-0 text-mil-dim" /> : <ChevronRight className="mt-0.5 h-4 w-4 shrink-0 text-mil-dim" />}
        <span className="min-w-0 flex-1">
          <span className="block text-sm text-mil-fg">{finding.title}</span>
          <span className="block truncate font-mono text-[11px] text-mil-dim">{finding.summary}</span>
        </span>
        {finding.count > 1 ? (
          <Badge variant="outline" className="shrink-0 border-white/10 text-[11px] text-mil-muted">×{finding.count}</Badge>
        ) : null}
        {finding.confidence === 'low' ? (
          <Badge variant="outline" className="shrink-0 border-white/10 text-[11px] text-mil-dim">consequence</Badge>
        ) : null}
      </button>
      {open ? (
        <div className="space-y-2 px-3 pb-3">
          {(finding.evidence || []).slice(0, 2).map((evidence, index) => (
            <EvidenceBlock key={index} evidence={evidence} />
          ))}
        </div>
      ) : null}
    </li>
  );
}

function CulpritCard({ culprit }) {
  const listed = culprit.in_mod_list;
  const dependents = culprit.listed_dependents || [];
  return (
    <li className="rounded-lg border border-white/[0.07] bg-mil-bg-deep/60 p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <a
            href={culprit.workshop_url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-sm font-medium text-brand-light hover:underline"
          >
            {culprit.name}
            <ExternalLink className="h-3 w-3" />
          </a>
          <p className="font-mono text-[11px] text-mil-dim">
            {culprit.mod_id}
            {culprit.installed_version ? ` · v${culprit.installed_version}` : ''}
            {culprit.previous_version ? ` (was ${culprit.previous_version})` : ''}
          </p>
        </div>
        <span className="rounded-full border border-white/10 px-2 py-0.5 text-[11px] text-mil-soft capitalize">
          {ROLE_LABEL[culprit.role] || culprit.role}
        </span>
      </div>
      <p className="mt-2 text-xs text-mil-muted">
        {listed
          ? 'In the mod list.'
          : culprit.role === 'scenario'
            ? 'Downloaded, but no longer in the mod list, so its scenario is not loaded.'
            : culprit.orphan
              ? 'Not in the mod list and nothing needs it — a leftover folder Reforger still loads.'
              : 'Not listed directly; '}
        {!listed && dependents.length ? `pulled in by ${dependents.map((d) => d.name).join(', ')}.` : ''}
        {listed && dependents.length ? ` ${dependents.length} listed mod(s) depend on it: ${dependents.map((d) => d.name).join(', ')}.` : ''}
      </p>
      {culprit.resource ? (
        <p className="mt-1 truncate font-mono text-[11px] text-mil-dim/70" title={culprit.resource}>{culprit.resource}</p>
      ) : null}
    </li>
  );
}

function CrashAnalysisModule() {
  const { serverId, canManage, fetchServer } = useOutletContext();
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [session, setSession] = useState(null);
  const [pending, setPending] = useState(null);
  const [restartAfter, setRestartAfter] = useState(true);
  const [running, setRunning] = useState(false);
  const [showHidden, setShowHidden] = useState(false);

  const load = useCallback(async (targetSession = session) => {
    setLoading(true);
    try {
      const query = targetSession ? `?session=${encodeURIComponent(targetSession)}` : '';
      const res = await apiClient.get(`/servers/${serverId}/crash-analysis${query}`);
      setData(res.data);
      setError('');
    } catch (err) {
      setError(formatApiError(err, 'Crash analysis failed to load.'));
    } finally {
      setLoading(false);
    }
  }, [serverId, session]);

  useEffect(() => { load(); }, [load]);

  const diagnosis = data?.diagnosis;
  const primary = diagnosis?.primary;
  const actions = useMemo(() => {
    if (!diagnosis) return [];
    if (diagnosis.stale && showHidden) return diagnosis.suggested_actions_hidden || [];
    return diagnosis.actions || [];
  }, [diagnosis, showHidden]);
  const otherFindings = (diagnosis?.findings || []).slice(1);

  const selectSession = (name) => {
    setSession(name);
    setShowHidden(false);
  };

  const startAction = (action) => {
    if (action.type === 'open_settings') {
      navigate(`/servers/${serverId}/config/server`);
      return;
    }
    setRestartAfter(action.restart !== false && !['restart', 'stop'].includes(action.type));
    setPending(action);
  };

  const executeAction = async () => {
    if (!pending) return;
    setRunning(true);
    try {
      const payload = {
        type: pending.type,
        mod_ids: pending.mod_ids || [],
        mod_id: pending.mod_id || null,
        version: pending.version || null,
        folder: pending.folder || null,
        revision: pending.revision || null,
        restart: restartAfter,
        session: diagnosis?.session || null,
      };
      const res = await apiClient.post(`/servers/${serverId}/crash-analysis/rectify`, payload, {
        validateStatus: (status) => status < 400,
      });
      const restartError = res.data?.restart?.error;
      let restartNote = restartAfter ? ' — restarting the server.' : '.';
      if (restartError) restartNote = `. Restart failed: ${restartError}`;
      toast({
        title: 'Fix applied',
        description: `${pending.label}${restartNote}`,
      });
      setPending(null);
      fetchServer?.(true);
      if (session) setSession(null);
      else await load(null);
    } catch (err) {
      toast({
        title: 'Fix not applied',
        description: formatApiError(err, err.message || 'The server refused the change.'),
        variant: 'destructive',
      });
    } finally {
      setRunning(false);
    }
  };

  if (loading && !data) {
    return (
      <div className="flex items-center justify-center gap-2 py-24 text-sm text-mil-muted">
        <Loader2 className="h-4 w-4 animate-spin" /> Reading the server's logs…
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 className="flex items-center gap-2 text-xl font-semibold text-brand-light">
            <Stethoscope className="h-5 w-5" /> Crash Analysis
          </h2>
          <p className="mt-1 max-w-2xl text-xs leading-relaxed text-mil-dim">
            Reads each boot's crash and console logs, finds the error that actually stopped the server
            (not the shutdown noise printed after it), and names the mod responsible.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => load()} disabled={loading} className="gap-2 self-start sm:self-auto">
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} /> Re-analyse
        </Button>
      </div>

      {error ? (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">{error}</div>
      ) : null}

      {!data?.sessions?.length && !error ? (
        <Panel>
          <div className="flex flex-col items-center gap-2 py-10 text-center text-sm text-mil-muted">
            <CircleDashed className="h-6 w-6 text-mil-dim/70" />
            No boot logs yet. Start the server once and its sessions will appear here.
          </div>
        </Panel>
      ) : null}

      {diagnosis ? (
        <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_320px]">
          <div className="min-w-0 space-y-5">
            <Panel>
              <div className="flex flex-wrap items-center gap-2">
                <OutcomeBadge outcome={diagnosis.outcome} />
                <span className="text-xs text-mil-dim">{sessionTime(diagnosis.session)}</span>
                {diagnosis.repeat_count > 1 ? (
                  <span className="text-xs text-amber-300/90">Same failure on the last {diagnosis.repeat_count} boots</span>
                ) : null}
              </div>

              {primary ? (
                <div className="mt-4 space-y-3">
                  <h3 className="flex items-start gap-2 text-lg font-semibold text-mil-bright">
                    <AlertOctagon className={`mt-1 h-5 w-5 shrink-0 ${['failed_to_start', 'crashed_runtime'].includes(diagnosis.outcome) ? 'text-red-400' : 'text-amber-400'}`} />
                    {primary.title}
                  </h3>
                  <p className="break-words rounded-md bg-black/30 px-3 py-2 font-mono text-[12.5px] text-red-200/90">{primary.summary}</p>
                  <p className="text-sm leading-relaxed text-mil-muted">{primary.explanation}</p>
                  {diagnosis.noise_note ? (
                    <p className="flex gap-2 rounded-md border border-white/[0.06] bg-white/[0.02] px-3 py-2 text-xs text-mil-muted">
                      <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-mil-soft" />
                      {diagnosis.noise_note}
                    </p>
                  ) : null}
                  <EvidenceBlock evidence={(primary.evidence || [])[0]} />
                </div>
              ) : (
                <div className="mt-4 flex items-center gap-2 text-sm text-emerald-300/90">
                  <CheckCircle2 className="h-4 w-4" /> No failure found in this session.
                </div>
              )}

              {diagnosis.stale ? (
                <div className="mt-4 flex flex-col gap-2 rounded-md border border-emerald-500/25 bg-emerald-500/5 px-3 py-2 text-xs text-emerald-200/90 sm:flex-row sm:items-center sm:justify-between">
                  <span>The server has come online since ({sessionTime(diagnosis.recovered_in)}). Fixes are hidden because they describe an older state.</span>
                  {(diagnosis.suggested_actions_hidden || []).length ? (
                    <button type="button" onClick={() => setShowHidden((v) => !v)} className="shrink-0 text-emerald-300 underline-offset-2 hover:underline">
                      {showHidden ? 'Hide fixes' : 'Show anyway'}
                    </button>
                  ) : null}
                </div>
              ) : null}
            </Panel>

            {actions.length ? (
              <Panel title="Suggested fixes" icon={Wrench}>
                <ul className="space-y-2">
                  {actions.map((action, index) => {
                    const Icon = ACTION_ICON[action.type] || Wrench;
                    const destructive = ['remove_mods', 'delete_addon', 'stop'].includes(action.type);
                    return (
                      <li key={`${action.type}-${index}`} className="flex flex-col gap-3 rounded-lg border border-white/[0.07] bg-mil-bg-deep/60 p-3 sm:flex-row sm:items-center sm:justify-between">
                        <div className="min-w-0">
                          <p className="flex items-center gap-2 text-sm font-medium text-mil-bright">
                            <Icon className={`h-4 w-4 shrink-0 ${index === 0 ? 'text-brand' : 'text-mil-muted'}`} />
                            {action.label}
                            {index === 0 ? <span className="rounded bg-brand/15 px-1.5 py-0.5 text-[11px] text-brand">Recommended</span> : null}
                          </p>
                          {action.detail ? <p className="mt-1 text-xs text-mil-dim">{action.detail}</p> : null}
                        </div>
                        <Button
                          size="sm"
                          variant={index === 0 && !destructive ? 'default' : 'outline'}
                          disabled={!canManage}
                          onClick={() => startAction(action)}
                          className={`shrink-0 ${destructive ? 'border-red-500/30 text-red-300 hover:bg-red-500/10' : ''}`}
                        >
                          {action.type === 'open_settings' ? 'Open settings' : 'Apply'}
                        </Button>
                      </li>
                    );
                  })}
                </ul>
                {!canManage ? <p className="mt-3 text-xs text-mil-dim">You need server management permission to apply fixes.</p> : null}
              </Panel>
            ) : null}

            {diagnosis.culprits?.length ? (
              <Panel title="Mods involved" icon={FileWarning}>
                <ul className="grid grid-cols-1 gap-2 lg:grid-cols-2">
                  {diagnosis.culprits.slice(0, 6).map((culprit) => (
                    <CulpritCard key={culprit.mod_id} culprit={culprit} />
                  ))}
                </ul>
              </Panel>
            ) : null}

            {otherFindings.length ? (
              <Panel title={`Other findings (${otherFindings.length})`} icon={Info}>
                <ul className="space-y-2">
                  {otherFindings.map((finding, index) => (
                    <FindingRow key={`${finding.kind}-${index}`} finding={finding} />
                  ))}
                </ul>
              </Panel>
            ) : null}
          </div>

          <aside className="min-w-0 space-y-5">
            <Panel title="Recent boots" icon={History}>
              <ol className="space-y-1">
                {(data.sessions || []).map((item) => {
                  const meta = OUTCOME[item.outcome] || { tone: 'muted', label: item.outcome };
                  const active = item.session === diagnosis.session;
                  return (
                    <li key={item.session}>
                      <button
                        type="button"
                        onClick={() => selectSession(item.session)}
                        className={`flex w-full items-start gap-2.5 rounded-md px-2 py-2 text-left transition-colors ${active ? 'bg-brand/10' : 'hover:bg-white/[0.03]'}`}
                      >
                        <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${DOT[meta.tone]}`} />
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center justify-between gap-2 text-xs">
                            <span className={active ? 'text-brand-light' : 'text-mil-soft'}>{sessionTime(item.session)}</span>
                            <span className="text-[11px] text-mil-dim/70">{meta.label}</span>
                          </span>
                          {item.title ? <span className="block truncate text-[11px] text-mil-dim">{item.title}</span> : null}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ol>
            </Panel>

            {diagnosis.mod_updates?.length ? (
              <Panel title="Updated during this boot" icon={RefreshCw}>
                <ul className="space-y-1 font-mono text-[11px] text-mil-muted">
                  {diagnosis.mod_updates.slice(0, 20).map((update) => (
                    <li key={update.mod_id} className="flex justify-between gap-2">
                      <span className="truncate">{update.mod_id}</span>
                      <span className="shrink-0">{update.from ? `${update.from} → ` : 'new '}{update.to}</span>
                    </li>
                  ))}
                </ul>
              </Panel>
            ) : null}
          </aside>
        </div>
      ) : null}

      <Dialog open={!!pending} onOpenChange={(open) => { if (!open && !running) setPending(null); }}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{pending?.label}</DialogTitle>
            <DialogDescription>{pending?.detail}</DialogDescription>
          </DialogHeader>
          {pending?.mod_ids?.length ? (
            <ul className="max-h-40 space-y-1 overflow-auto rounded-md border border-white/[0.06] bg-black/30 p-2 font-mono text-[11px] text-mil-muted">
              {pending.mod_ids.map((id) => {
                const known = (diagnosis?.culprits || []).find((c) => c.mod_id === id)
                  || (diagnosis?.culprits || []).flatMap((c) => c.listed_dependents || []).find((d) => d.mod_id === id);
                return <li key={id}>{known?.name ? `${known.name} · ` : ''}{id}</li>;
              })}
            </ul>
          ) : null}
          {pending && !['restart', 'stop'].includes(pending.type) ? (
            <label className="flex items-center gap-2 text-sm text-mil-soft">
              <Checkbox checked={restartAfter} onCheckedChange={(value) => setRestartAfter(value === true)} />
              Restart the server afterwards
            </label>
          ) : null}
          <p className="text-xs text-mil-dim">
            Mod changes record a mod revision, so they can be undone from Mod History.
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPending(null)} disabled={running}>Cancel</Button>
            <Button onClick={executeAction} disabled={running} className="gap-2">
              {running ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Apply fix
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export default CrashAnalysisModule;
