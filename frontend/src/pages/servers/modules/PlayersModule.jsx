import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useOutletContext } from 'react-router';
import { useRealtimeTopic } from '@/hooks/useRealtime';
import apiClient from '@/lib/apiClient';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import {
  AlertTriangle,
  Clock,
  Loader2,
  RefreshCw,
  Search,
  Shield,
  Users,
} from 'lucide-react';
import { formatApiError } from '@/utils/errorMessages';
import { CommandEmptyState, CommandLoadingState } from '@/components/tactical/CommandUI';

function formatDuration(seconds) {
  if (seconds == null) return 'Pending';
  const total = Math.max(Number(seconds) || 0, 0);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${secs}s`;
  return `${secs}s`;
}

function formatTimestamp(value) {
  if (!value) return 'Pending';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Pending';
  return date.toLocaleString();
}

function filterSession(session, term) {
  if (!term) return true;
  const needle = term.toLowerCase();
  return [
    session.player_name,
    session.player_guid,
    session.player_be_guid,
    session.player_uuid,
    session.endpoint,
    session.player_slot != null ? String(session.player_slot) : '',
  ].some((value) => String(value || '').toLowerCase().includes(needle));
}

function PlayersModule() {
  const { server, serverId } = useOutletContext();
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  const maxPlayers = useMemo(() => server?.config?.game?.maxPlayers || 64, [server]);
  const isRunning = server?.status === 'running';

  const fetchPlayers = useCallback(async () => {
    setError(null);
    try {
      const res = await apiClient.get(`/servers/${serverId}/players`, {
        params: { limit: 100 },
      });
      setData(res.data);
    } catch (err) {
      setError(formatApiError(err, 'Failed to load player tracking data.'));
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [serverId]);

  useEffect(() => {
    setLoading(true);
    fetchPlayers();
  }, [fetchPlayers]);

  useEffect(() => {
    const intervalId = setInterval(fetchPlayers, 20_000);
    return () => clearInterval(intervalId);
  }, [fetchPlayers]);

  // Live: refresh instantly when this server's state changes (player
  // join/leave, map change) via the realtime game topic; the interval
  // above is now just a safety net.
  useRealtimeTopic('game', (evt) => {
    if (evt.event === 'reconnected' || !evt.data?.server_id || evt.data.server_id === serverId) fetchPlayers();
  });

  const summary = data?.summary || {};
  const activePlayers = useMemo(
    () => (data?.active_players || []).filter((player) => filterSession(player, search)),
    [data, search],
  );
  const recentSessions = useMemo(
    () => (data?.sessions || []).filter((session) => filterSession(session, search)),
    [data, search],
  );

  const cards = [
    {
      label: 'Online',
      value: `${summary.online ?? 0}`,
      suffix: `/ ${maxPlayers}`,
      icon: Users,
      color: 'text-green-400',
    },
    {
      label: 'Peak Today',
      value: `${summary.peak_today ?? 0}`,
      suffix: '',
      icon: Clock,
      color: 'text-brand',
    },
    {
      label: 'Avg Session',
      value: formatDuration(summary.avg_session_seconds),
      suffix: '',
      icon: Clock,
      color: 'text-blue-400',
    },
    {
      label: 'Unique 24h',
      value: `${summary.unique_24h ?? 0}`,
      suffix: '',
      icon: Shield,
      color: 'text-purple-400',
    },
  ];

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {cards.map((card) => {
          const Icon = card.icon;
          return (
            <Card key={card.label} className="border-zinc-800 bg-mil-bg-deep/60">
              <CardContent className="p-4">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-mil-muted capitalize">{card.label}</span>
                  <Icon className={`h-4 w-4 ${card.color}`} />
                </div>
                <div className="mt-2 text-2xl font-bold text-white" style={{ fontFamily: "var(--font-heading)" }}>
                  {loading ? <span className="text-sm text-mil-dim">Loading</span> : card.value}
                  {card.suffix ? <span className="text-sm text-mil-dim"> {card.suffix}</span> : null}
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      <Card className="border-zinc-800 bg-mil-bg-deep/60">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between gap-3">
            <CardTitle className="flex items-center gap-2 text-sm font-semibold tracking-wider text-mil-muted">
              <Users className="h-4 w-4 text-brand" /> ACTIVE PLAYERS
            </CardTitle>
            <div className="flex items-center gap-2">
              {data?.updated_at ? (
                <span className="hidden text-xs text-mil-muted sm:inline font-medium capitalize">
                  Updated {new Date(data.updated_at).toLocaleTimeString()}
                </span>
              ) : null}
              <Button
                size="sm"
                variant="outline"
                className="h-7 border-zinc-800 text-xs text-mil-muted"
                onClick={fetchPlayers}
                disabled={loading}
              >
                {loading ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <RefreshCw className="mr-1 h-3 w-3" />}
                Refresh
              </Button>
            </div>
          </div>
          <div className="relative mt-2">
            <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-mil-dim" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by player, GUID, BE GUID, slot, or endpoint..."
              className="h-8 border-zinc-800 bg-mil-bg-deep/60 pl-9 text-xs text-white placeholder:text-mil-dim"
            />
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {error ? (
            <div className="flex items-center gap-2 border border-[rgba(232,131,58,0.2)] bg-[rgba(232,131,58,0.05)] px-3 py-3 text-sm text-[#f4a261]">
              <AlertTriangle className="h-4 w-4 shrink-0" />
              <span>{error}</span>
            </div>
          ) : null}

          {!isRunning && !(recentSessions.length || activePlayers.length) ? (
            <div className="flex flex-col items-center justify-center py-12 text-mil-dim">
              <AlertTriangle className="mb-2 h-8 w-8 text-mil-dim" />
              <p className="text-sm">Server is offline.</p>
              <p className="mt-1 text-xs">Recent player sessions will appear here once player tracking has data to display.</p>
            </div>
          ) : loading && !data ? (
            <CommandLoadingState immersive={false} label="Loading player tracking" rows={3} />
          ) : activePlayers.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-mil-dim">
              <Users className="mb-2 h-8 w-8 text-mil-dim" />
              <p className="text-sm">No active players are currently tracked.</p>
              <p className="mt-1 text-xs">New BattlEye connection lines will populate this list automatically.</p>
            </div>
          ) : (
            <div className="space-y-3">
              {activePlayers.map((player) => (
                <div key={player.id} className="grid gap-3 border border-zinc-800 bg-mil-bg-panel p-3 md:grid-cols-[minmax(0,1fr)_repeat(5,minmax(0,160px))]">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold text-white">{player.player_name || 'Unknown Player'}</span>
                      {player.player_slot != null ? (
                        <span className="text-xs text-mil-muted font-medium capitalize">Slot #{player.player_slot}</span>
                      ) : null}
                    </div>
                    <div className="mt-1 text-xs text-mil-dim">
                      {player.endpoint || 'Endpoint pending'}
                    </div>
                  </div>
                  <div>
                    <div className="text-xs text-mil-muted font-medium">Guid</div>
                    <div className="mt-1 break-all font-mono text-xs text-mil-fg">{player.player_guid || 'Pending'}</div>
                  </div>
                  <div>
                    <div className="text-xs text-mil-muted font-medium">UUID</div>
                    <div className="mt-1 break-all font-mono text-xs text-mil-fg">{player.player_uuid || player.player_identity || 'Pending'}</div>
                  </div>
                  <div>
                    <div className="text-xs text-mil-muted font-medium">Be guid</div>
                    <div className="mt-1 break-all font-mono text-xs text-mil-fg">{player.player_be_guid || 'Pending'}</div>
                  </div>
                  <div>
                    <div className="text-xs text-mil-muted font-medium">Join Time</div>
                    <div className="mt-1 text-xs text-mil-fg">{formatTimestamp(player.connected_at)}</div>
                  </div>
                  <div>
                    <div className="text-xs text-mil-muted font-medium">Time In Session</div>
                    <div className="mt-1 text-xs text-mil-fg">{formatDuration(player.session_duration_seconds)}</div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="border-zinc-800 bg-mil-bg-deep/60">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-sm font-semibold tracking-wider text-mil-muted">
            <Clock className="h-4 w-4 text-brand" /> RECENT PLAYER SESSIONS
          </CardTitle>
        </CardHeader>
        <CardContent>
          {recentSessions.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-10 text-mil-dim">
              <Clock className="mb-2 h-8 w-8 text-mil-dim" />
              <p className="text-sm">No player session history yet.</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full text-left text-xs">
                <thead>
                  <tr className="border-b border-zinc-800 text-[11px] text-mil-dim">
                    <th className="py-2 pr-3 font-medium">Player</th>
                    <th className="py-2 pr-3 font-medium">Status</th>
                    <th className="py-2 pr-3 font-medium">GUID</th>
                    <th className="py-2 pr-3 font-medium">UUID</th>
                    <th className="py-2 pr-3 font-medium">BE GUID</th>
                    <th className="py-2 pr-3 font-medium">Join Time</th>
                    <th className="py-2 pr-3 font-medium">Disconnect Time</th>
                    <th className="py-2 pr-3 font-medium">Reason</th>
                    <th className="py-2 pr-0 font-medium">Duration</th>
                  </tr>
                </thead>
                <tbody>
                  {recentSessions.map((session) => (
                    <tr key={session.id} className="border-b border-zinc-900/80 text-mil-fg">
                      <td className="py-3 pr-3 align-top">
                        <div className="font-medium text-white">{session.player_name || 'Unknown Player'}</div>
                        <div className="mt-1 text-xs text-mil-muted font-medium capitalize">
                          {session.player_slot != null ? `Slot #${session.player_slot}` : 'Slot pending'}
                        </div>
                      </td>
                      <td className="py-3 pr-3 align-top">
                        <span className={`capitalize inline-flex items-center px-2 py-1 text-[11px] ${
 session.status === 'active'
 ? 'border border-[rgba(34,197,94,0.25)] bg-[rgba(34,197,94,0.08)] text-green-400'
 : 'border border-zinc-800 bg-mil-bg-panel text-mil-muted'
 }`}>
                          {session.status === 'active' ? 'Active' : session.disconnect_inferred ? 'Closed (Inferred)' : 'Closed'}
                        </span>
                      </td>
                      <td className="py-3 pr-3 align-top font-mono">{session.player_guid || 'Pending'}</td>
                      <td className="py-3 pr-3 align-top font-mono">{session.player_uuid || session.player_identity || 'Pending'}</td>
                      <td className="py-3 pr-3 align-top font-mono">{session.player_be_guid || 'Pending'}</td>
                      <td className="py-3 pr-3 align-top">{formatTimestamp(session.connected_at)}</td>
                      <td className="py-3 pr-3 align-top">
                        {session.status === 'active' ? 'Active' : formatTimestamp(session.disconnected_at)}
                      </td>
                      <td className="py-3 pr-3 align-top text-mil-muted">
                        {session.status === 'active'
                          ? 'Connected'
                          : session.disconnect_reason || (session.disconnect_inferred ? 'Inferred from snapshot' : 'Disconnected')}
                      </td>
                      <td className="py-3 pr-0 align-top">{formatDuration(session.session_duration_seconds)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

export default PlayersModule;
