import React from 'react';
import { AlertOctagon, AlertTriangle, CheckCircle2, CircleDashed, FileCheck2, FileWarning, FileX2, Info, MinusCircle } from 'lucide-react';

// Shared pieces of the Config Health console: the verdict
// badge, the 0-100 score ring, the check list, lint findings and config drift.

export const VERDICTS = {
  online: { label: 'Online', badge: 'border-emerald-500/35 bg-emerald-500/10 text-emerald-300', dot: 'bg-emerald-400 animate-pulse', ring: '#34d399' },
  degraded: { label: 'Degraded', badge: 'border-amber-500/35 bg-amber-500/10 text-amber-300', dot: 'bg-amber-300 animate-pulse', ring: '#fbbf24' },
  down: { label: 'Down', badge: 'border-red-500/40 bg-red-500/10 text-red-300', dot: 'bg-red-400', ring: '#f87171' },
  stopped: { label: 'Stopped', badge: 'border-zinc-600/50 bg-zinc-700/10 text-mil-muted', dot: 'bg-zinc-500', ring: '#71717a' },
  deleting: { label: 'Deleting', badge: 'border-zinc-600/50 bg-zinc-700/10 text-mil-muted', dot: 'bg-zinc-500', ring: '#71717a' },
};

export function VerdictBadge({ overall }) {
  const v = VERDICTS[overall] || VERDICTS.stopped;
  return (
    <span className={`inline-flex items-center gap-2 border px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wider ${v.badge}`} style={{ fontFamily: 'var(--font-condensed)' }}>
      <span className={`h-2 w-2 rounded-full ${v.dot}`} aria-hidden="true" />
      {v.label}
    </span>
  );
}

export function ScoreRing({ score, overall, size = 56 }) {
  const v = VERDICTS[overall] || VERDICTS.stopped;
  const r = (size - 6) / 2;
  const c = 2 * Math.PI * r;
  const pct = typeof score === 'number' ? score / 100 : 0;
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }} title="Health score: 100, minus 30 per failed check, 10 per warning, 5 per config-rule warning">
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} stroke="rgba(255,255,255,0.08)" strokeWidth="4" fill="none" />
        <circle cx={size / 2} cy={size / 2} r={r} stroke={v.ring} strokeWidth="4" fill="none" strokeLinecap="round"
          strokeDasharray={c} strokeDashoffset={c * (1 - pct)} style={{ transition: 'stroke-dashoffset 600ms ease' }} />
      </svg>
      <span className="absolute inset-0 flex items-center justify-center text-sm font-semibold text-mil-fg" style={{ fontFamily: 'var(--font-mono)' }}>
        {typeof score === 'number' ? score : '-'}
      </span>
    </div>
  );
}

const CHECK_ICON = {
  pass: { Icon: CheckCircle2, cls: 'text-emerald-400' },
  warn: { Icon: AlertTriangle, cls: 'text-amber-300' },
  fail: { Icon: AlertOctagon, cls: 'text-red-400' },
  skip: { Icon: MinusCircle, cls: 'text-zinc-500' },
};

export function CheckList({ checks = [], compact = false }) {
  return (
    <ul className={compact ? 'space-y-1' : 'space-y-1.5'}>
      {checks.map((check) => {
        const { Icon, cls } = CHECK_ICON[check.state] || CHECK_ICON.skip;
        return (
          <li key={check.id} className="flex items-start gap-2 text-xs">
            <Icon className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${cls}`} aria-label={check.state} />
            <span className="w-32 shrink-0 text-mil-muted">{check.label}</span>
            <span className={`min-w-0 text-mil-dim ${compact ? 'truncate' : 'break-words'}`} title={check.detail}>{check.detail}</span>
          </li>
        );
      })}
    </ul>
  );
}

export const CONFIG_STATES = {
  in_sync: { label: 'In sync', Icon: FileCheck2, cls: 'text-emerald-300' },
  drift: { label: 'Drift', Icon: FileWarning, cls: 'text-amber-300' },
  missing: { label: 'Missing', Icon: FileX2, cls: 'text-red-300' },
  invalid: { label: 'Invalid JSON', Icon: FileX2, cls: 'text-red-300' },
  unreadable: { label: 'Unreadable', Icon: FileX2, cls: 'text-red-300' },
};

export function ConfigStateBadge({ state, driftCount }) {
  const s = CONFIG_STATES[state] || { label: state || 'Unknown', Icon: CircleDashed, cls: 'text-mil-muted' };
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs font-medium ${s.cls}`}>
      <s.Icon className="h-3.5 w-3.5" />
      {s.label}{state === 'drift' && driftCount ? ` (${driftCount})` : ''}
    </span>
  );
}

const SEVERITY = {
  error: { label: 'Error', cls: 'border-red-500/30 bg-red-500/5', tag: 'text-red-300', Icon: AlertOctagon },
  warning: { label: 'Warning', cls: 'border-amber-500/30 bg-amber-500/5', tag: 'text-amber-300', Icon: AlertTriangle },
  info: { label: 'Note', cls: 'border-sky-500/25 bg-sky-500/5', tag: 'text-sky-300', Icon: Info },
};

export function LintCounts({ counts = {} }) {
  return (
    <span className="inline-flex items-center gap-2 text-xs" style={{ fontFamily: 'var(--font-mono)' }}>
      <span className={counts.error ? 'text-red-300' : 'text-zinc-600'} title="Errors">{counts.error || 0}E</span>
      <span className={counts.warning ? 'text-amber-300' : 'text-zinc-600'} title="Warnings">{counts.warning || 0}W</span>
      <span className={counts.info ? 'text-sky-300' : 'text-zinc-600'} title="Notes">{counts.info || 0}N</span>
    </span>
  );
}

export function FindingsList({ findings = [], empty = 'No problems found.' }) {
  if (!findings.length) {
    return <p className="flex items-center gap-2 text-xs text-emerald-300"><CheckCircle2 className="h-3.5 w-3.5" /> {empty}</p>;
  }
  const order = { error: 0, warning: 1, info: 2 };
  const sorted = [...findings].sort((a, b) => (order[a.severity] ?? 3) - (order[b.severity] ?? 3));
  return (
    <ul className="space-y-1.5">
      {sorted.map((f, i) => {
        const s = SEVERITY[f.severity] || SEVERITY.info;
        return (
          <li key={`${f.path}-${f.rule}-${i}`} className={`border px-3 py-2 text-xs ${s.cls}`}>
            <div className="flex flex-wrap items-center gap-2">
              <s.Icon className={`h-3.5 w-3.5 shrink-0 ${s.tag}`} />
              <span className={`font-semibold uppercase tracking-wider ${s.tag}`} style={{ fontFamily: 'var(--font-condensed)' }}>{s.label}</span>
              <code className="text-[11px] text-mil-muted">{f.path}</code>
            </div>
            <p className="mt-1 text-mil-fg">{f.message}</p>
            {f.fix ? <p className="mt-0.5 text-mil-dim">Fix: {f.fix}</p> : null}
          </li>
        );
      })}
    </ul>
  );
}

const DRIFT_KIND = { changed: 'Changed', missing_on_disk: 'Missing on disk', extra_on_disk: 'Only on disk' };

export function DriftTable({ drift = [] }) {
  if (!drift.length) return null;
  return (
    <div className="overflow-x-auto border border-zinc-800">
      <table className="w-full text-left text-xs">
        <thead className="bg-mil-bg-panel/80 text-mil-dim">
          <tr>
            <th className="px-3 py-2 font-medium">Field</th>
            <th className="px-3 py-2 font-medium">What</th>
            <th className="px-3 py-2 font-medium">Saved config</th>
            <th className="px-3 py-2 font-medium">File on disk</th>
          </tr>
        </thead>
        <tbody>
          {drift.map((d) => (
            <tr key={d.path} className="border-t border-zinc-800/80 align-top">
              <td className="px-3 py-1.5"><code className="text-mil-muted">{d.path}</code></td>
              <td className="px-3 py-1.5 text-amber-300">{DRIFT_KIND[d.kind] || d.kind}</td>
              <td className="max-w-xs break-all px-3 py-1.5 font-mono text-mil-fg">{String(d.expected)}</td>
              <td className="max-w-xs break-all px-3 py-1.5 font-mono text-mil-fg">{String(d.on_disk)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
