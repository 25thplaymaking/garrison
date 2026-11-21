import React, { useState, useMemo } from 'react';
import { useOutletContext } from 'react-router';
import { useRealtimeTopic } from '@/hooks/useRealtime';
import { motion, useReducedMotion } from 'framer-motion';
import { useApiQuery } from '@/hooks/useApiQuery';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import MeasuredChartContainer from '@/components/charts/MeasuredChartContainer';
import { CommandEmptyState, CommandLoadingState } from '@/components/tactical/CommandUI';
import {
  Area,
  AreaChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ReferenceLine,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  Activity,
  BarChart3,
  Bot,
  Clock,
  Cpu,
  HardDrive,
  Network,
  RefreshCw,
  Users,
} from 'lucide-react';
const PERIODS = [
  { value: '1h', label: '1 Hour' },
  { value: '6h', label: '6 Hours' },
  { value: '24h', label: '1 Day' },
  { value: '7d', label: '7 Days' },
  { value: '30d', label: '30 Days' },
];

const RESOLUTION_MAP = {
  '1h': '1m',
  '6h': '1m',
  '24h': '5m',
  '7d': '1h',
  '30d': '1h',
};

function normalizeMetricPoint(point) {
  return {
    ...point,
    cpu_percent: point.cpu_host_percent ?? point.cpu_percent ?? point.avg_cpu_percent ?? null,
    cpu_host_percent: point.cpu_host_percent ?? point.cpu_percent ?? point.avg_cpu_percent ?? null,
    cpu_raw_percent: point.cpu_raw_percent ?? point.avg_cpu_raw_percent ?? null,
    memory_mb: point.memory_mb ?? point.avg_memory_mb ?? null,
    player_count: point.player_count ?? point.max_player_count ?? point.avg_player_count ?? null,
    server_fps: point.server_fps ?? point.avg_server_fps ?? point.fps ?? null,
    avg_player_ping_ms: point.avg_player_ping_ms ?? point.ping ?? null,
    ai_count: point.ai_count ?? point.avg_ai_count ?? null,
    vehicle_count: point.vehicle_count ?? point.avg_vehicle_count ?? null,
    network_rx_bytes: point.network_rx_bytes ?? point.max_network_rx_bytes ?? null,
    network_tx_bytes: point.network_tx_bytes ?? point.max_network_tx_bytes ?? null,
  };
}

function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let index = 0;
  let value = bytes;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[index]}`;
}

function formatMegabytes(value) {
  if (value == null || !Number.isFinite(Number(value))) return 'N/A';
  const mb = Number(value);
  if (mb >= 1024) return `${(mb / 1024).toFixed(mb >= 10240 ? 1 : 2)} GB`;
  return `${mb.toFixed(mb >= 100 ? 0 : 1)} MB`;
}

function formatUptime(seconds) {
  if (seconds == null) return 'N/A';
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours >= 24) return `${Math.floor(hours / 24)}d ${hours % 24}h`;
  return `${hours}h ${minutes}m`;
}

function formatMetricValue(key, value) {
  if (value == null || !Number.isFinite(Number(value))) return 'N/A';
  const numeric = Number(value);
  if (key === 'cpu_cores_used') return `${numeric.toFixed(2)} cores`;
  if (key.includes('cpu')) return `${numeric.toFixed(1)}%`;
  if (key.includes('memory')) return formatMegabytes(numeric);
  if (key === 'fps') return `${numeric.toFixed(1)} FPS`;
  if (key === 'uptime_seconds') return formatUptime(numeric);
  if (key === 'avg_player_ping_ms') return `${numeric.toFixed(1)} ms`;
  if (key === 'rx_mb' || key === 'tx_mb') return formatBytes(numeric * 1024 * 1024);
  if (key === 'player_count') return `${Math.round(numeric)} players`;
  if (key === 'ai') return `${Math.round(numeric)} AI`;
  if (key === 'vehicles') return `${Math.round(numeric)} vehicles`;
  return `${numeric.toFixed(1)}`;
}

function formatPercentTick(value) {
  if (value == null || !Number.isFinite(Number(value))) return '';
  return `${Math.round(Number(value))}%`;
}

function formatMemoryTick(value) {
  if (value == null || !Number.isFinite(Number(value))) return '';
  const mb = Number(value);
  if (mb >= 1024) {
    const gb = mb / 1024;
    return `${gb.toFixed(gb >= 10 ? 0 : 1)}G`;
  }
  return `${Math.round(mb)}M`;
}

function formatCountTick(value) {
  if (value == null || !Number.isFinite(Number(value))) return '';
  return `${Math.round(Number(value))}`;
}

function formatFpsTick(value) {
  if (value == null || !Number.isFinite(Number(value))) return '';
  return `${Math.round(Number(value))}`;
}

function formatNetworkTick(value) {
  if (value == null || !Number.isFinite(Number(value))) return '';
  const mb = Number(value);
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)}G`;
  return `${Math.round(mb)}M`;
}

function formatTick(timestamp, period) {
  if (!timestamp) return '';
  const date = new Date(timestamp);
  if (period === '7d' || period === '30d') {
    return `${date.getMonth() + 1}/${date.getDate()}`;
  }
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function ChartTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded border border-zinc-800 bg-mil-bg-deep/95 px-3 py-2 text-xs shadow-xl">
      <div className="mb-2 text-mil-muted">{label}</div>
      {payload.map((entry) => (
        <div key={entry.dataKey} className="flex items-center justify-between gap-4">
          <span style={{ color: entry.color }}>{entry.name}</span>
          <span className="text-mil-fg">
            {formatMetricValue(entry.dataKey, entry.value)}
          </span>
        </div>
      ))}
    </div>
  );
}

function getNumericValues(points, key) {
  return points
    .map((point) => point[key])
    .filter((value) => Number.isFinite(value));
}

function getPaddedDomain(values, { floor = 0, minimumSpan = 1 } = {}) {
  if (!values.length) return [floor, floor + minimumSpan];
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (min === max) {
    const pad = Math.max(minimumSpan, Math.abs(max) * 0.15 || minimumSpan);
    return [Math.max(floor, min - pad), max + pad];
  }
  const span = Math.max(max - min, minimumSpan);
  const pad = Math.max(minimumSpan * 0.2, span * 0.15);
  return [Math.max(floor, min - pad), max + pad];
}

function ChartShell({ title, subtitle, icon: Icon, current, secondary, children }) {
  const prefersReducedMotion = useReducedMotion();
  return (
    <motion.div
      initial={prefersReducedMotion ? false : { opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.22 }}
    >
    <Card className="overflow-hidden border-[rgba(232,131,58,0.12)] bg-mil-bg-deep/72">
      <div className="h-px bg-linear-to-r from-transparent via-brand-light/30 to-transparent" />
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle role="heading" aria-level={3} className="flex items-center gap-2 text-sm font-semibold tracking-wider text-mil-muted">
              <Icon className="h-4 w-4 text-brand" />
              {title}
            </CardTitle>
            {subtitle ? <p className="mt-1 text-xs text-mil-dim">{subtitle}</p> : null}
          </div>
          {current ? (
            <div className="text-right">
              <div className="text-lg font-semibold text-white" style={{ fontFamily: "var(--font-heading)" }}>{current}</div>
              {secondary ? <div className="text-xs text-mil-muted font-medium capitalize">{secondary}</div> : null}
            </div>
          ) : null}
        </div>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
    </motion.div>
  );
}

function EmptyChartState({ loading }) {
  // Same height as a chart so the panel does not jump when data arrives.
  return (
    <div className="flex min-h-[280px] flex-col justify-center">
      {loading ? (
        <CommandLoadingState immersive={false} label="Loading metrics" rows={3} />
      ) : (
        <CommandEmptyState icon={BarChart3} title="No metrics available yet" description="Metrics are collected while the server is running." />
      )}
    </div>
  );
}

function SparseChartState({ label }) {
  return (
    <div className="flex h-[280px] flex-col items-center justify-center text-mil-dim">
      <BarChart3 className="mb-3 h-8 w-8 text-mil-dim" />
      <p className="text-sm">More telemetry is needed for {label.toLowerCase()}.</p>
      <p className="mt-1 text-xs">The summary cards show the current sample, but the chart waits for a usable series.</p>
    </div>
  );
}

function MetricsModule({ serverId: selectedServerId, server: selectedServer } = {}) {
  const context = useOutletContext();
  const serverId = selectedServerId || context?.serverId;
  const server = selectedServer || context?.server || {};
  const prefersReducedMotion = useReducedMotion();
  const [period, setPeriod] = useState('24h');
  const { data, isPending: loading, isFetching, error, refetch } = useApiQuery(`/servers/${serverId}/metrics`, {
    params: { period, resolution: RESOLUTION_MAP[period] },
    enabled: Boolean(serverId),
    refetchInterval: 30_000,
    retry: false,
  });
  useRealtimeTopic('game', (evt) => {
    if (document.visibilityState !== 'hidden' && (evt.event === 'reconnected' || !evt.data?.server_id || evt.data.server_id === serverId)) refetch();
  });
  const metrics = useMemo(() => (data?.metrics || []).map(normalizeMetricPoint), [data]);
  const latest = data?.latest || {};
  const trend = useMemo(() => {
    const average = (key) => {
      const points = metrics.filter((point) => Number.isFinite(point[key]));
      const count = points.reduce((sum, point) => sum + (point.sample_count || 1), 0);
      return count ? points.reduce((sum, point) => sum + point[key] * (point.sample_count || 1), 0) / count : null;
    };
    const players = metrics.map((point) => point.player_count).filter(Number.isFinite);
    return { avg_cpu: average('cpu_host_percent'), avg_memory: average('memory_mb'), avg_server_fps: average('server_fps'), max_player_count: players.length ? Math.max(...players) : null };
  }, [metrics]);
  const sampledAt = latest.timestamp ? new Date(latest.timestamp) : null;
  const stale = sampledAt && Date.now() - sampledAt.getTime() > 90_000;
  const stopped = ['stopped', 'created', 'error', 'crash_loop', 'deletion_pending'].includes(data?.server_status || server.status);

  const chartData = useMemo(() => metrics.map((point) => ({
    ...point,
    tick: formatTick(point.timestamp, period),
    rx_mb: point.network_rx_bytes == null ? null : Number((point.network_rx_bytes / (1024 * 1024)).toFixed(2)),
    tx_mb: point.network_tx_bytes == null ? null : Number((point.network_tx_bytes / (1024 * 1024)).toFixed(2)),
    fps: point.server_fps != null ? Number(point.server_fps.toFixed(1)) : null,
    ai: point.ai_count != null ? point.ai_count : null,
    vehicles: point.vehicle_count != null ? point.vehicle_count : null,
  })), [metrics, period]);

  // One notice instead of nine identical empty charts when the window holds
  // nothing, with a way to widen it (a server stopped for three days showed
  // "No metrics available yet" everywhere on the default 1-day view).
  const noSamplesInPeriod = !loading && !error && chartData.length === 0;
  const periodIndex = PERIODS.findIndex((option) => option.value === period);
  const longerPeriods = PERIODS.slice(periodIndex + 1).filter((option) => {
    if (!sampledAt) return false;
    const spanMs = { '6h': 6, '24h': 24, '7d': 168, '30d': 720 }[option.value] * 3_600_000;
    return Date.now() - sampledAt.getTime() <= spanMs;
  }).slice(0, 2);

  const cpuValues = getNumericValues(chartData, 'cpu_host_percent');
  const memoryValues = getNumericValues(chartData, 'memory_mb');
  const playerValues = getNumericValues(chartData, 'player_count');
  const fpsValues = getNumericValues(chartData, 'fps');
  const aiValues = getNumericValues(chartData, 'ai');
  const vehicleValues = getNumericValues(chartData, 'vehicles');
  const rxValues = getNumericValues(chartData, 'rx_mb');

  const cpuMemoryPointCount = Math.max(cpuValues.length, memoryValues.length);
  const fpsPointCount = fpsValues.length;
  const aiPointCount = Math.max(aiValues.length, vehicleValues.length);

  const cpuDomain = getPaddedDomain(cpuValues, { floor: 0, minimumSpan: 10 });
  const memoryDomain = getPaddedDomain(memoryValues, { floor: 0, minimumSpan: 64 });
  const playerDomain = getPaddedDomain(playerValues, { floor: 0, minimumSpan: 4 });
  const fpsDomain = getPaddedDomain(fpsValues, { floor: 0, minimumSpan: 10 });
  const aiDomain = getPaddedDomain([...aiValues, ...vehicleValues], { floor: 0, minimumSpan: 10 });
  const rxDomain = getPaddedDomain(rxValues, { floor: 0, minimumSpan: 1 });

  const summaryCards = [
    {
      label: 'CPU',
      value: latest.cpu_host_percent != null || latest.cpu_percent != null ? `${(latest.cpu_host_percent ?? latest.cpu_percent).toFixed(1)}%` : 'Unavailable',
      avg: trend.avg_cpu != null ? `${trend.avg_cpu.toFixed(1)}% avg` : 'Container metric',
      icon: Cpu,
      color: 'text-blue-400',
      border: 'border-blue-600/20',
      bg: 'bg-blue-600/5',
    },
    {
      label: 'Memory',
      value: latest.memory_mb != null ? `${latest.memory_mb.toFixed(0)} MB` : 'Unavailable',
      avg: trend.avg_memory != null ? `${trend.avg_memory.toFixed(0)} MB avg` : 'Container metric',
      icon: HardDrive,
      color: 'text-purple-400',
      border: 'border-purple-600/20',
      bg: 'bg-purple-600/5',
    },
    {
      label: 'Server FPS',
      value: latest.server_fps != null ? `${latest.server_fps.toFixed(1)}` : 'Unavailable',
      avg: trend.avg_server_fps != null ? `${trend.avg_server_fps.toFixed(1)} avg` : 'Requires logStats',
      icon: Activity,
      color: 'text-emerald-400',
      border: 'border-emerald-600/20',
      bg: 'bg-emerald-600/5',
    },
    {
      label: 'Active Players',
      value: latest.player_count != null ? `${latest.player_count}/${latest.max_players || '?'}` : 'Unavailable',
      avg: trend.max_player_count != null ? `Peak ${trend.max_player_count}` : 'A2S / RCON metric',
      icon: Users,
      color: 'text-green-400',
      border: 'border-green-600/20',
      bg: 'bg-green-600/5',
    },
    {
      label: 'AI Entities',
      value: latest.ai_count != null ? `${latest.ai_count}` : 'Unavailable',
      avg: latest.vehicle_count != null ? `${latest.vehicle_count} vehicles` : 'Requires logStats',
      icon: Bot,
      color: 'text-orange-400',
      border: 'border-orange-500/20',
      bg: 'bg-orange-500/5',
    },
    {
      label: 'Network RX',
      value: latest.network_rx_bytes != null ? formatBytes(latest.network_rx_bytes) : 'Unavailable',
      avg: null,
      icon: Network,
      color: 'text-cyan-400',
      border: 'border-cyan-600/20',
      bg: 'bg-cyan-600/5',
    },
    {
      label: 'Uptime',
      value: stopped ? 'Offline' : latest.uptime_seconds != null ? formatUptime(latest.uptime_seconds) : 'Awaiting sample',
      avg: null,
      icon: Clock,
      color: 'text-brand',
      border: 'border-brand-dark/20',
      bg: 'bg-brand/5',
    },
  ];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-semibold tracking-wider text-mil-muted" style={{ fontFamily: "var(--font-heading)" }}>
          PERFORMANCE METRICS · SELECTED PERIOD
        </h2>
        <div className="flex flex-wrap items-center gap-2">
          {PERIODS.map((option) => (
            <Button
              key={option.value}
              size="sm"
              variant={period === option.value ? 'default' : 'outline'}
              onClick={() => setPeriod(option.value)}
              aria-pressed={period === option.value}
              className={`min-h-11 text-xs ${
                period === option.value
                  ? 'bg-brand text-black hover:bg-brand-light'
                  : 'border-zinc-800 text-mil-muted hover:text-white'
              }`}
            >
              {option.label}
            </Button>
          ))}
          <Button aria-label="Refresh" size="sm" variant="outline" onClick={() => refetch()} disabled={isFetching} className="min-h-11 border-zinc-800 text-xs text-mil-muted">
            <RefreshCw className={`h-3 w-3 ${isFetching ? 'animate-spin' : ''}`} />
          </Button>
        </div>
      </div>

      {error ? <p role="alert" className="border border-red-500/30 bg-red-500/5 p-3 text-sm text-red-200">Unable to refresh statistics. {data ? 'Showing the last successful response.' : 'Use Refresh to try again.'}</p> : null}
      <p role="status" className="text-xs text-mil-muted">
        {stopped ? 'Server offline · historical measurements' : stale ? 'Telemetry stale · last known measurements' : sampledAt ? 'Latest server sample' : 'Awaiting telemetry'}
        {sampledAt ? ` · ${sampledAt.toLocaleString()}` : ''}
      </p>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {summaryCards.map((card) => {
          const Icon = card.icon;
          return (
            <motion.div
              key={card.label}
              initial={prefersReducedMotion ? false : { opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.18 }}
            >
            <Card className={`${card.border} ${card.bg} overflow-hidden`}>
              <div className="h-px bg-linear-to-r from-transparent via-white/10 to-transparent" />
              <CardContent className="p-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-mil-muted capitalize">{card.label}</span>
                  <Icon className={`h-3.5 w-3.5 ${card.color}`} />
                </div>
                <div className="mt-1.5 text-xl font-bold text-white" style={{ fontFamily: "var(--font-heading)" }}>
                  {loading ? <div className="h-6 w-12 animate-pulse rounded bg-zinc-800" /> : card.value}
                </div>
                {card.avg ? <div className="mt-0.5 text-[11px] text-mil-dim">{card.avg}</div> : null}
              </CardContent>
            </Card>
            </motion.div>
          );
        })}
      </div>

      {noSamplesInPeriod ? (
        <div role="status" className="flex flex-col items-center gap-3 border border-[rgba(232,131,58,0.12)] bg-mil-bg-deep/72 px-4 py-10 text-center">
          <BarChart3 className="h-8 w-8 text-mil-dim" aria-hidden="true" />
          <p className="text-sm text-mil-fg">
            No samples in the last {PERIODS.find((option) => option.value === period)?.label.toLowerCase() || period}.
          </p>
          <p className="max-w-md text-xs text-mil-dim">
            {sampledAt
              ? `Metrics are only collected while the server runs; the last sample is from ${sampledAt.toLocaleString()}.`
              : 'Metrics are collected while the server is running. None have been recorded yet.'}
          </p>
          {longerPeriods.length > 0 && sampledAt ? (
            <div className="flex flex-wrap justify-center gap-2">
              {longerPeriods.map((option) => (
                <Button
                  key={option.value}
                  size="sm"
                  variant="outline"
                  onClick={() => setPeriod(option.value)}
                  className="min-h-11 border-zinc-800 text-xs text-mil-muted hover:text-white"
                >
                  Show {option.label.toLowerCase()}
                </Button>
              ))}
            </div>
          ) : null}
        </div>
      ) : (
      <div className="grid gap-6 xl:grid-cols-2">
        <ChartShell
          title="CPU & Memory"
          subtitle="Container load over time."
          icon={Cpu}
          current={latest.cpu_host_percent != null || latest.cpu_percent != null ? `${(latest.cpu_host_percent ?? latest.cpu_percent).toFixed(1)}% CPU` : null}
          secondary={latest.memory_mb != null ? formatMegabytes(latest.memory_mb) : null}
        >
          {chartData.length === 0 ? (
            <EmptyChartState loading={loading} />
          ) : cpuMemoryPointCount < 2 ? (
            <SparseChartState label="CPU and memory" />
          ) : (
            <MeasuredChartContainer className="h-[280px]" observeKey={period}>
              {({ width, height }) => (
                <AreaChart width={width} height={height} data={chartData} margin={{ top: 8, right: 18, bottom: 0, left: 4 }}>
                  <defs>
                    <linearGradient id="cpuFill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#60a5fa" stopOpacity={0.35} />
                      <stop offset="95%" stopColor="#60a5fa" stopOpacity={0.02} />
                    </linearGradient>
                    <linearGradient id="memoryFill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#a855f7" stopOpacity={0.25} />
                      <stop offset="95%" stopColor="#a855f7" stopOpacity={0.02} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid stroke="rgba(125,125,125,0.32)" vertical={false} />
                  <XAxis dataKey="tick" tick={{ fontSize: 10, fill: '#777777' }} axisLine={false} tickLine={false} minTickGap={24} />
                  <YAxis yAxisId="cpu" domain={cpuDomain} tickFormatter={formatPercentTick} tick={{ fontSize: 10, fill: '#949494' }} axisLine={false} tickLine={false} width={42} />
                  <YAxis yAxisId="memory" domain={memoryDomain} orientation="right" tickFormatter={formatMemoryTick} tick={{ fontSize: 10, fill: '#949494' }} axisLine={false} tickLine={false} width={48} />
                  <Tooltip content={<ChartTooltip />} />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  <ReferenceLine yAxisId="cpu" y={85} stroke="rgba(255,170,0,0.35)" strokeDasharray="4 4" label={{ value: '85%', fill: '#ffaa00', fontSize: 10 }} />
                  <Area yAxisId="cpu" type="monotone" dataKey="cpu_host_percent" name="CPU" stroke="#60a5fa" fill="url(#cpuFill)" strokeWidth={2} isAnimationActive={!prefersReducedMotion} />
                  <Area yAxisId="memory" type="monotone" dataKey="memory_mb" name="Memory" stroke="#a855f7" fill="url(#memoryFill)" strokeWidth={2} isAnimationActive={!prefersReducedMotion} />
                </AreaChart>
              )}
            </MeasuredChartContainer>
          )}
        </ChartShell>

        <ChartShell
          title="Active Players"
          subtitle="Population over time, sourced from A2S and RCON."
          icon={Users}
          current={latest.player_count != null ? `${latest.player_count}/${latest.max_players || '?'}` : null}
          secondary={trend.max_player_count != null ? `Peak ${trend.max_player_count}` : null}
        >
          {chartData.length === 0 ? (
            <EmptyChartState loading={loading} />
          ) : playerValues.length < 2 ? (
            <SparseChartState label="active players" />
          ) : (
            <MeasuredChartContainer className="h-[280px]" observeKey={period}>
              {({ width, height }) => (
                <LineChart width={width} height={height} data={chartData} margin={{ top: 8, right: 16, bottom: 0, left: 4 }}>
                  <CartesianGrid stroke="rgba(125,125,125,0.32)" vertical={false} />
                  <XAxis dataKey="tick" tick={{ fontSize: 10, fill: '#777777' }} axisLine={false} tickLine={false} minTickGap={24} />
                  <YAxis domain={playerDomain} tickFormatter={formatCountTick} allowDecimals={false} tick={{ fontSize: 10, fill: '#949494' }} axisLine={false} tickLine={false} width={40} />
                  <Tooltip content={<ChartTooltip />} />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  <Line type="monotone" dataKey="player_count" name="Players" stroke="#22c55e" strokeWidth={2.4} dot={playerValues.length <= 2 ? { r: 2 } : false} connectNulls={false} isAnimationActive={!prefersReducedMotion} />
                </LineChart>
              )}
            </MeasuredChartContainer>
          )}
        </ChartShell>

        <ChartShell
          title="Server FPS"
          subtitle="Derived from logStats. Provisioning now enables it by default."
          icon={Activity}
          current={latest.server_fps != null ? `${latest.server_fps.toFixed(1)} FPS` : null}
          secondary={trend.avg_server_fps != null ? `${trend.avg_server_fps.toFixed(1)} avg` : null}
        >
          {chartData.length === 0 || !chartData.some((point) => point.fps != null) ? (
            <EmptyChartState loading={loading} />
          ) : fpsPointCount < 2 ? (
            <SparseChartState label="server FPS" />
          ) : (
            <MeasuredChartContainer className="h-[280px]" observeKey={period}>
              {({ width, height }) => (
                <LineChart width={width} height={height} data={chartData} margin={{ top: 8, right: 16, bottom: 0, left: 4 }}>
                  <CartesianGrid stroke="rgba(125,125,125,0.32)" vertical={false} />
                  <XAxis dataKey="tick" tick={{ fontSize: 10, fill: '#777777' }} axisLine={false} tickLine={false} minTickGap={24} />
                  <YAxis domain={fpsDomain} tickFormatter={formatFpsTick} allowDecimals={false} tick={{ fontSize: 10, fill: '#949494' }} axisLine={false} tickLine={false} width={40} />
                  <Tooltip content={<ChartTooltip />} />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  <ReferenceLine y={30} stroke="rgba(255,170,0,0.36)" strokeDasharray="4 4" label={{ value: 'low FPS', fill: '#ffaa00', fontSize: 10 }} />
                  <Line type="monotone" dataKey="fps" name="Server FPS" stroke="#10b981" strokeWidth={2.7} dot={fpsValues.length <= 2 ? { r: 2 } : false} connectNulls={false} isAnimationActive={!prefersReducedMotion} />
                </LineChart>
              )}
            </MeasuredChartContainer>
          )}
        </ChartShell>

        <ChartShell
          title="AI & Vehicles"
          subtitle="Entity counts from logStats output."
          icon={Bot}
          current={latest.ai_count != null ? `${latest.ai_count} AI` : null}
          secondary={latest.vehicle_count != null ? `${latest.vehicle_count} vehicles` : null}
        >
          {chartData.length === 0 || !chartData.some((point) => point.ai != null || point.vehicles != null) ? (
            <EmptyChartState loading={loading} />
          ) : aiPointCount < 2 ? (
            <SparseChartState label="AI entities" />
          ) : (
            <MeasuredChartContainer className="h-[280px]" observeKey={period}>
              {({ width, height }) => (
                <AreaChart width={width} height={height} data={chartData} margin={{ top: 8, right: 16, bottom: 0, left: 4 }}>
                  <defs>
                    <linearGradient id="aiFill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#f97316" stopOpacity={0.3} />
                      <stop offset="95%" stopColor="#f97316" stopOpacity={0.02} />
                    </linearGradient>
                    <linearGradient id="vehFill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#eab308" stopOpacity={0.25} />
                      <stop offset="95%" stopColor="#eab308" stopOpacity={0.02} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid stroke="rgba(125,125,125,0.32)" vertical={false} />
                  <XAxis dataKey="tick" tick={{ fontSize: 10, fill: '#777777' }} axisLine={false} tickLine={false} minTickGap={24} />
                  <YAxis domain={aiDomain} tickFormatter={formatCountTick} allowDecimals={false} tick={{ fontSize: 10, fill: '#949494' }} axisLine={false} tickLine={false} width={40} />
                  <Tooltip content={<ChartTooltip />} />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  <Area type="monotone" dataKey="ai" name="AI Entities" stroke="#f97316" fill="url(#aiFill)" strokeWidth={2} connectNulls={false} isAnimationActive={!prefersReducedMotion} />
                  <Area type="monotone" dataKey="vehicles" name="Vehicles" stroke="#eab308" fill="url(#vehFill)" strokeWidth={2} connectNulls={false} isAnimationActive={!prefersReducedMotion} />
                </AreaChart>
              )}
            </MeasuredChartContainer>
          )}
        </ChartShell>

        <ChartShell
          title="Network RX"
          subtitle="Inbound volume since runtime start. Resets on restart."
          icon={Network}
          current={latest.network_rx_bytes != null ? formatBytes(latest.network_rx_bytes) : null}
          secondary="Inbound"
        >
          {chartData.length === 0 ? (
            <EmptyChartState loading={loading} />
          ) : rxValues.length < 2 ? (
            <SparseChartState label="network RX" />
          ) : (
            <MeasuredChartContainer className="h-[280px]" observeKey={period}>
              {({ width, height }) => (
                <AreaChart width={width} height={height} data={chartData} margin={{ top: 8, right: 16, bottom: 0, left: 4 }}>
                  <defs>
                    <linearGradient id="rxFill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#06b6d4" stopOpacity={0.3} />
                      <stop offset="95%" stopColor="#06b6d4" stopOpacity={0.02} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid stroke="rgba(125,125,125,0.32)" vertical={false} />
                  <XAxis dataKey="tick" tick={{ fontSize: 10, fill: '#777777' }} axisLine={false} tickLine={false} minTickGap={24} />
                  <YAxis domain={rxDomain} tickFormatter={formatNetworkTick} tick={{ fontSize: 10, fill: '#949494' }} axisLine={false} tickLine={false} width={44} />
                  <Tooltip content={<ChartTooltip />} />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  <Area type="monotone" dataKey="rx_mb" name="Network RX" stroke="#06b6d4" fill="url(#rxFill)" strokeWidth={2} isAnimationActive={!prefersReducedMotion} />
                </AreaChart>
              )}
            </MeasuredChartContainer>
          )}
        </ChartShell>
        {[
          { key: 'tx_mb', title: 'Network TX', subtitle: 'Outbound volume since runtime start (MiB). Resets on restart.', icon: Network, color: '#e8833a', tick: formatNetworkTick },
          { key: 'avg_player_ping_ms', title: 'Player Ping', subtitle: 'Average player latency in milliseconds, when available.', icon: Activity, color: '#38bdf8', tick: (value) => `${Math.round(value)}ms` },
          { key: 'uptime_seconds', title: 'Uptime', subtitle: 'Runtime duration at each sample. Drops indicate restarts.', icon: Clock, color: '#e8833a', tick: formatUptime },
          { key: 'cpu_cores_used', title: 'CPU Cores Used', subtitle: 'Processor usage expressed as occupied cores.', icon: Cpu, color: '#a78bfa', tick: (value) => Number(value).toFixed(1) },
        ].map((chart) => (
          <ChartShell key={chart.key} title={chart.title} subtitle={chart.subtitle} icon={chart.icon}>
            {getNumericValues(chartData, chart.key).length < 2 ? <EmptyChartState loading={loading} /> : (
              <MeasuredChartContainer className="h-[280px]" observeKey={period}>
                {({ width, height }) => (
                  <LineChart width={width} height={height} data={chartData} margin={{ top: 8, right: 16, bottom: 0, left: 4 }}>
                    <CartesianGrid stroke="rgba(125,125,125,0.32)" vertical={false} />
                    <XAxis dataKey="tick" tick={{ fontSize: 10, fill: '#949494' }} minTickGap={24} />
                    <YAxis domain={[0, 'auto']} tickFormatter={chart.tick} tick={{ fontSize: 10, fill: '#949494' }} width={60} />
                    <Tooltip content={<ChartTooltip />} />
                    <Line type="linear" dataKey={chart.key} name={chart.title} stroke={chart.color} strokeWidth={2} dot={false} connectNulls={false} isAnimationActive={false} />
                  </LineChart>
                )}
              </MeasuredChartContainer>
            )}
          </ChartShell>
        ))}
      </div>
      )}

      <section className="border border-brand/15 bg-mil-bg-panel p-4">
        <h3 className="mb-4 text-sm font-semibold text-brand-light">Server Details</h3>
        <dl className="grid grid-cols-1 gap-4 text-sm sm:grid-cols-2 xl:grid-cols-3">
          {[
            ['Name', server.name], ['Status', data?.server_status || server.status],
            ['Scenario', latest.current_map || server.config?.game?.scenarioId], ['Version', latest.version],
            ['Runtime', server.container_name], ['Image', server.docker_image],
            ['Player capacity', latest.max_players ?? server.config?.game?.maxPlayers],
            ['CPU cores available', latest.cpu_core_count], ['CPU raw usage', latest.cpu_raw_percent == null ? null : `${latest.cpu_raw_percent.toFixed(1)}%`],
            ['Memory limit', latest.memory_limit_mb == null ? null : formatMegabytes(latest.memory_limit_mb)],
            ['Network received', latest.network_rx_bytes == null ? null : formatBytes(latest.network_rx_bytes)],
            ['Network sent', latest.network_tx_bytes == null ? null : formatBytes(latest.network_tx_bytes)],
            ['Player ping', latest.avg_player_ping_ms == null ? null : `${latest.avg_player_ping_ms} ms`],
            ['Vehicles', latest.vehicle_count], ['Game port', server.ports?.game], ['Query port', server.ports?.query],
            ['Installed mods', server.mods?.length], ['Last sample', sampledAt?.toLocaleString()],
          ].map(([label, value]) => <div key={label} className="min-w-0"><dt className="text-xs text-mil-muted">{label}</dt><dd className="mt-1 break-words text-mil-fg">{value ?? 'Not reported'}</dd></div>)}
        </dl>
      </section>

      <div className="flex items-center justify-end text-xs text-mil-dim">
        {chartData.length} data points - {PERIODS.find((option) => option.value === period)?.label || period}
      </div>
    </div>
  );
}

export default MetricsModule;
