import React, { useState } from 'react';
import { Link } from 'react-router';
import { useApiQuery } from '@/hooks/useApiQuery';
import { CommandEmptyState, CommandLoadingState } from '@/components/tactical/CommandUI';
import { AlertTriangle, RefreshCw, Server } from 'lucide-react';
import { Button } from '@/components/ui/button';
import MetricsModule from './modules/MetricsModule';

export default function ServerStatistics() {
  const [selectedId, setSelectedId] = useState('');
  const { data, isPending, error, refetch } = useApiQuery('/servers', { refetchInterval: 30_000 });
  const servers = Array.isArray(data) ? data : data?.servers || [];
  const server = servers.find((item) => item.id === selectedId) || servers[0];

  if (isPending) return <CommandLoadingState immersive={false} label="Loading server statistics" rows={3} />;
  if (error) {
    return (
      <div role="alert">
        <CommandEmptyState
          icon={AlertTriangle}
          title="Unable to load servers"
          description="The server list did not load, so there are no statistics to show yet."
          action={<Button type="button" variant="command" onClick={() => refetch()}><RefreshCw aria-hidden="true" /> Retry</Button>}
        />
      </div>
    );
  }
  if (!server) {
    return <CommandEmptyState icon={Server} title="No managed servers yet" description="Statistics appear here once a server is added in Fleet." />;
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4 border-b border-brand/15 pb-5">
        <div className="min-w-0 w-full sm:w-auto">
          <label htmlFor="statistics-server" className="mb-2 block text-xs text-mil-muted font-medium">Server statistics</label>
          <select id="statistics-server" value={server.id} onChange={(event) => setSelectedId(event.target.value)} className="min-h-11 w-full max-w-full border border-brand/30 bg-mil-bg-deep px-3 text-sm text-brand-light sm:w-96">
            {servers.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        </div>
        <Link to={`/servers/${server.id}`} className="inline-flex min-h-11 items-center text-sm text-brand underline">Open server workspace</Link>
      </div>
      <MetricsModule key={server.id} serverId={server.id} server={server} />
    </div>
  );
}
