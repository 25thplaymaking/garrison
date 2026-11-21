import React, { useCallback, useEffect, useState } from 'react';
import { BellRing, Loader2, Plus, Send, Trash2 } from 'lucide-react';
import apiClient from '@/lib/apiClient';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { formatApiError } from '@/utils/errorMessages';

/**
 * Webhooks that receive server-down alerts. The backend posts JSON with a
 * `content` line, so a Discord channel webhook URL works as-is.
 */
export default function AlertWebhooksCard() {
  const [hooks, setHooks] = useState([]);
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null);

  const load = useCallback(async () => {
    try {
      const { data } = await apiClient.get('/servers/webhooks');
      setHooks(Array.isArray(data) ? data : []);
    } catch (err) {
      setMessage({ ok: false, text: formatApiError(err, 'Could not load webhooks.') });
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const add = async (event) => {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      await apiClient.post('/servers/webhooks', { name, url, events: ['server_down'] });
      setName('');
      setUrl('');
      await load();
    } catch (err) {
      setMessage({ ok: false, text: formatApiError(err, 'Could not add the webhook.') });
    } finally {
      setBusy(false);
    }
  };

  const test = async (hook) => {
    setMessage(null);
    try {
      const { data } = await apiClient.post(`/servers/webhooks/${hook.id}/test`);
      const code = data?.status_code;
      const ok = Boolean(code) && code < 300;
      let text = `Test sent to ${hook.name}.`;
      if (!code) text = `${hook.name}: could not reach the webhook URL.`;
      else if (!ok) text = `${hook.name} answered HTTP ${code}. Check the URL.`;
      setMessage({ ok, text });
    } catch (err) {
      setMessage({ ok: false, text: formatApiError(err, 'Test failed.') });
    }
  };

  const remove = async (hook) => {
    try {
      await apiClient.delete(`/servers/webhooks/${hook.id}`);
      await load();
    } catch (err) {
      setMessage({ ok: false, text: formatApiError(err, 'Could not delete the webhook.') });
    }
  };

  return (
    <Card className="border-zinc-800 bg-mil-bg-panel">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 font-heading text-base text-brand-light">
          <BellRing className="h-5 w-5" /> Server-down alerts
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-xs text-mil-muted">
          When a server crashes or fails to start, Garrison posts one alert to each webhook below. Paste a Discord
          channel webhook URL (Channel settings, Integrations, Webhooks), or any HTTPS endpoint that accepts JSON.
        </p>
        {hooks.length > 0 && (
          <ul className="divide-y divide-mil-line border border-mil-line">
            {hooks.map((hook) => (
              <li key={hook.id} className="flex flex-wrap items-center gap-2 px-3 py-2 text-xs">
                <span className="font-medium text-mil-fg">{hook.name}</span>
                <span className="min-w-0 flex-1 truncate text-mil-dim" style={{ fontFamily: 'var(--font-mono)' }}>{hook.url}</span>
                <Button type="button" size="sm" variant="commandOutline" onClick={() => test(hook)}>
                  <Send aria-hidden="true" /> Test
                </Button>
                <Button type="button" size="sm" variant="commandDanger" onClick={() => remove(hook)} aria-label={`Delete ${hook.name}`}>
                  <Trash2 aria-hidden="true" />
                </Button>
              </li>
            ))}
          </ul>
        )}
        <form onSubmit={add} className="grid gap-3 md:grid-cols-[12rem_1fr_auto] md:items-end">
          <div className="space-y-1.5">
            <Label htmlFor="hook-name">Name</Label>
            <Input id="hook-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Discord #server-alerts" required maxLength={100} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="hook-url">Webhook URL (https)</Label>
            <Input id="hook-url" type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://discord.com/api/webhooks/…" required />
          </div>
          <Button type="submit" variant="commandPrimary" disabled={busy}>
            {busy ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Plus aria-hidden="true" />}
            Add webhook
          </Button>
        </form>
        {message && <p role="status" className={`text-xs ${message.ok ? 'text-green-400' : 'text-red-300'}`}>{message.text}</p>}
      </CardContent>
    </Card>
  );
}
