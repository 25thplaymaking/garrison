import React, { useCallback, useState } from 'react';
import apiClient from '@/lib/apiClient';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { CheckCircle, Globe, Loader2, Wifi, XCircle } from 'lucide-react';
import { formatApiError } from '@/utils/errorMessages';
import AlertWebhooksCard from '@/components/servers/AlertWebhooksCard';

const LIST_SITE = 'https://reforgermods.net';

function IntegrationsModule() {

  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);

  // The server list needs no key: the check is one real search through the site.
  const handleTestServerList = useCallback(async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await apiClient.get('/servers/server-list/search', { params: { per_page: 1 } });
      const age = Number(res.data.list_age_seconds);
      setTestResult({
        success: true,
        message: `Connected: ${Number(res.data.total || 0).toLocaleString()} public servers online${Number.isFinite(age) ? `, list refreshed ${Math.round(age)} s ago` : ''}.`,
      });
    } catch (err) {
      setTestResult({ success: false, message: formatApiError(err, 'Could not reach the server list') });
    } finally {
      setTesting(false);
    }
  }, []);

  return (
    <div className="flex flex-col gap-6">
      {/* Hero banner */}
      <div className="relative overflow-hidden corner-bracket c2-corner-live rounded-lg border border-[rgba(232,131,58,0.15)] backdrop-blur-sm p-6 bg-mil-bg-card">
        <p className="mb-1 font-condensed text-xs text-brand font-medium">
          Configuration
        </p>
        <h1 className="font-heading text-2xl font-bold text-brand-light">
          Integrations
        </h1>
        <p className="mt-1 font-body text-sm text-mil-muted">
          Outside services the server tools use.
        </p>
      </div>

      {/* ── Public server list (Compare / Mirror) ─────────────────────────── */}
      <Card className="border-zinc-800 bg-mil-bg-panel">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="flex items-center gap-2 font-heading text-base text-brand-light">
              <Globe className="h-5 w-5" /> Public server list
            </CardTitle>
            <Badge variant="outline" className="border-green-600/30 text-[11px] text-green-400">
              Free · no key
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-xs text-mil-muted">
            Compare / Mirror searches every public Arma Reforger server through{' '}
            <a href={LIST_SITE} target="_blank" rel="noopener noreferrer" className="text-brand hover:underline">
              reforgermods.net
            </a>
            , which reads Bohemia&apos;s server list about once a minute, with the mods each server runs.
            It replaced BattleMetrics, whose API now needs a paid subscription. The free tier allows
            60 lookups a minute and 5,000 a day from this panel.
          </p>

          <div className="flex flex-wrap items-center gap-3">
            <Button
              variant="outline"
              size="sm"
              onClick={handleTestServerList}
              disabled={testing}
              className="h-8 border-zinc-700 text-xs text-mil-muted hover:border-[rgba(232,131,58,0.3)] hover:text-brand-light"
            >
              {testing ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Wifi className="mr-1.5 h-3.5 w-3.5" />}
              Test Connection
            </Button>

            {testResult && (
              <div role="status" className="flex items-center gap-2 text-xs">
                {testResult.success ? (
                  <CheckCircle className="h-3.5 w-3.5 text-green-400" />
                ) : (
                  <XCircle className="h-3.5 w-3.5 text-red-400" />
                )}
                <span className={testResult.success ? 'text-green-400' : 'text-red-400'}>{testResult.message}</span>
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      <AlertWebhooksCard />
    </div>
  );
}

export default IntegrationsModule;
