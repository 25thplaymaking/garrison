import React, { useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, Loader2, ShieldCheck } from 'lucide-react';
import apiClient from '@/lib/apiClient';
import { FindingsList, LintCounts } from '@/components/servers/health/HealthParts';

// Live Config Health lint for the config editor. Checks the
// draft exactly as the backend would write it, 700 ms after the last edit, so
// a bad value shows up before Save instead of as a failed server start.

export default function ConfigLintPanel({ serverId, draft, onCounts }) {
  const [result, setResult] = useState(null);
  const [checking, setChecking] = useState(false);
  const [open, setOpen] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!draft || typeof draft !== 'object') return undefined;
    let cancelled = false;
    const timer = setTimeout(async () => {
      setChecking(true);
      try {
        const res = await apiClient.post(`/config-health/servers/${serverId}/lint`, { config: draft });
        if (cancelled) return;
        setResult(res.data);
        setFailed(false);
        onCounts?.(res.data.counts);
        if (res.data.counts?.error) setOpen(true);
      } catch {
        if (!cancelled) { setFailed(true); onCounts?.(null); }
      } finally {
        if (!cancelled) setChecking(false);
      }
    }, 700);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [serverId, draft, onCounts]);

  const counts = result?.counts || {};
  const tone = counts.error ? 'border-red-600/35 bg-red-600/5' : counts.warning ? 'border-amber-600/30 bg-amber-600/5' : 'border-emerald-600/25 bg-emerald-600/5';
  const total = (counts.error || 0) + (counts.warning || 0) + (counts.info || 0);
  return (
    <div className={`border px-3 py-2 ${tone}`}>
      <button type="button" onClick={() => setOpen((v) => !v)} className="flex w-full items-center gap-2 text-left text-xs" aria-expanded={open}>
        {open ? <ChevronDown className="h-3.5 w-3.5 text-mil-dim" /> : <ChevronRight className="h-3.5 w-3.5 text-mil-dim" />}
        <ShieldCheck className="h-3.5 w-3.5 text-brand" />
        <span className="font-semibold text-mil-muted">Config check</span>
        <span className="text-mil-dim">
          {failed ? 'Could not run the check.' : !result ? 'Checking...' : counts.error ? 'Fix the errors below before you start the server.' : total ? 'No blocking problems.' : 'Passes every rule.'}
        </span>
        <span className="ml-auto flex items-center gap-2">
          {checking ? <Loader2 className="h-3 w-3 animate-spin text-mil-dim" /> : null}
          {result ? <LintCounts counts={counts} /> : null}
        </span>
      </button>
      {open && result ? <div className="mt-2"><FindingsList findings={result.findings} empty="The draft passes every config rule." /></div> : null}
    </div>
  );
}
