import React, { useCallback, useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight, Loader2, RefreshCw } from 'lucide-react';
import apiClient from '@/lib/apiClient';
import { auditLogs } from '@/lib/endpoints';
import { Button } from '@/components/ui/button';
import { formatApiError } from '@/utils/errorMessages';

const PAGE = 50;

function humanAction(action) {
  return String(action || '').replace(/_/g, ' ');
}

function Details({ row }) {
  const parts = [row.before && ['Before', row.before], row.after && ['After', row.after], row.metadata && ['Details', row.metadata]].filter(Boolean);
  if (!parts.length) return <span className="text-mil-dim">-</span>;
  return (
    <details>
      <summary className="cursor-pointer text-mil-muted hover:text-mil-fg">Show</summary>
      <div className="mt-2 space-y-2">
        {parts.map(([label, value]) => (
          <div key={label}>
            <p className="text-[11px] text-mil-dim">{label}</p>
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all bg-mil-bg-deep p-2 text-[11px] text-mil-soft" style={{ fontFamily: 'var(--font-mono)' }}>
              {JSON.stringify(value, null, 2)}
            </pre>
          </div>
        ))}
      </div>
    </details>
  );
}

export default function AuditLogPage() {
  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [skip, setSkip] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await apiClient.get(auditLogs, { params: { limit: PAGE, skip } });
      setItems(data.items || []);
      setTotal(data.total || 0);
      setError('');
    } catch (err) {
      setError(formatApiError(err, 'Could not load the audit log.'));
    } finally {
      setLoading(false);
    }
  }, [skip]);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="mx-auto max-w-6xl">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-mil-bright">Audit log</h1>
          <p className="mt-1 text-sm text-mil-muted">Every change made through the panel, newest first. Passwords and keys are masked.</p>
        </div>
        <Button type="button" variant="commandOutline" onClick={load} disabled={loading}>
          <RefreshCw className={loading ? 'animate-spin' : ''} aria-hidden="true" /> Refresh
        </Button>
      </div>
      {error && <p role="alert" className="mt-4 text-sm text-red-300">{error}</p>}
      <div className="mt-6 overflow-x-auto border border-mil-line">
        <table className="w-full text-sm">
          <thead className="bg-mil-bg-panel text-left text-xs text-mil-muted">
            <tr>
              <th className="px-3 py-2 font-medium">When</th>
              <th className="px-3 py-2 font-medium">Who</th>
              <th className="px-3 py-2 font-medium">Action</th>
              <th className="px-3 py-2 font-medium">Target</th>
              <th className="px-3 py-2 font-medium">Details</th>
            </tr>
          </thead>
          <tbody>
            {loading && !items.length && (
              <tr><td colSpan={5} className="px-3 py-6 text-center"><Loader2 className="mx-auto h-5 w-5 animate-spin text-mil-muted" aria-label="Loading" /></td></tr>
            )}
            {!loading && !items.length && (
              <tr><td colSpan={5} className="px-3 py-6 text-center text-mil-muted">Nothing recorded yet.</td></tr>
            )}
            {items.map((row) => (
              <tr key={row.id} className="border-t border-mil-line align-top">
                <td className="whitespace-nowrap px-3 py-2 text-mil-muted">{new Date(row.timestamp).toLocaleString()}</td>
                <td className="px-3 py-2 text-mil-fg">{row.username}</td>
                <td className="px-3 py-2 capitalize text-mil-fg">{humanAction(row.action_type)}</td>
                <td className="px-3 py-2 text-mil-muted">{row.resource_type}{row.resource_id ? ` ${String(row.resource_id).slice(0, 12)}` : ''}</td>
                <td className="px-3 py-2 text-xs"><Details row={row} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="mt-3 flex items-center justify-end gap-2 text-sm text-mil-muted">
        <span>{total ? `${skip + 1}-${Math.min(skip + PAGE, total)} of ${total}` : ''}</span>
        <Button type="button" size="sm" variant="commandOutline" disabled={skip === 0} onClick={() => setSkip(Math.max(0, skip - PAGE))} aria-label="Newer">
          <ChevronLeft aria-hidden="true" />
        </Button>
        <Button type="button" size="sm" variant="commandOutline" disabled={skip + PAGE >= total} onClick={() => setSkip(skip + PAGE)} aria-label="Older">
          <ChevronRight aria-hidden="true" />
        </Button>
      </div>
    </div>
  );
}
