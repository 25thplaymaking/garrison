import React from 'react';
import { Link } from 'react-router';
import { motion, useReducedMotion } from 'framer-motion';
import { Card, CardContent, CardFooter, CardHeader } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import MeasuredChartContainer from '@/components/charts/MeasuredChartContainer';
import { Play, Square, RotateCcw, Users, Gauge, Clock, Info, Box, RadioTower, AlertTriangle, Loader2, Stethoscope } from 'lucide-react';
import { LineChart, Line, Tooltip, YAxis } from 'recharts';
import { canRestartServer, canStartServer, canStopServer, currentFailureMessage, isServerDegraded, normalizeServer } from '@/utils/serverStatus';

const PERIODS = ['1d', '7d', '30d'];

function getStatusVisuals(status) {
  switch (status) {
    case 'running':
      return {
        label: 'Online',
        badge: 'border-[rgba(232,131,58,0.32)] bg-[rgba(232,131,58,0.09)] text-brand-light',
        glow: '',
        dotCls: 'h-2.5 w-2.5 rounded-full bg-green-400 animate-pulse',
      };
    case 'degraded':
      return {
        label: 'Degraded',
        badge: 'border-amber-500/35 bg-amber-500/10 text-amber-300',
        glow: '',
        dotCls: 'h-2.5 w-2.5 rounded-full bg-amber-300 animate-pulse',
      };
    case 'error':
    case 'crash_loop':
      return {
        label: status === 'crash_loop' ? 'Crash Loop' : 'Error',
        badge: 'border-red-500/35 bg-red-500/10 text-red-300',
        glow: 'border-red-500/30',
        dotCls: 'h-2.5 w-2.5 rounded-full bg-red-500 animate-[blink_1s_step-end_infinite]',
      };
    case 'starting':
    case 'stopping':
      return {
        label: status === 'starting' ? 'Starting' : 'Stopping',
        badge: 'border-amber-500/35 bg-amber-500/10 text-amber-300',
        glow: '',
        dotCls: 'h-2.5 w-2.5 rounded-full bg-amber-400 animate-spin border-t-2 border-amber-200',
      };
    case 'deletion_pending':
      return {
        label: 'Deleting',
        badge: 'border-amber-500/35 bg-amber-500/10 text-amber-300',
        glow: '',
        dotCls: 'h-2.5 w-2.5 animate-spin rounded-full border-2 border-amber-300 border-t-transparent',
      };
    case 'stopped':
    case 'created':
    default:
      return {
        label: status === 'created' ? 'Created' : 'Offline',
        badge: 'border-[#7d7d7d]/40 bg-[#7d7d7d]/10 text-mil-muted',
        glow: '',
        dotCls: 'h-2.5 w-2.5 rounded-full bg-zinc-600',
      };
  }
}

// The health monitor writes "<what happened>. Cause: <diagnosis>" into the
// failure message; the cause is the part an operator needs on the card.
const CAUSE_SIGNALS = [
  /Can't compile|script module/i,
  /Param "#\//,
  /mission header/i,
  /not downloadable|DependenciesUnresolvable/i,
  /Virtual Machine Exception|NULL pointer/i,
  /Unknown class/i,
];

// `strict` accepts only a diagnosed cause: a server that is not in a failed
// state still carries whatever summary its last provisioning step wrote, which
// is not a crash cause.
export function failureCause(server, { strict = false } = {}) {
  const message = currentFailureMessage(server);
  if (!message) return '';
  if (strict && !message.includes('Cause: ') && !message.includes('Top engine errors: ')) return '';
  const marker = message.indexOf('Cause: ');
  if (marker >= 0) return message.slice(marker + 7).trim();
  const top = message.indexOf('Top engine errors: ');
  if (top >= 0) {
    // Older summaries listed errors by frequency; pick the line that names a
    // cause rather than whichever happened to be first.
    const lines = message.slice(top + 19).split(' | ').map((line) => line.trim()).filter(Boolean);
    const rank = (line) => {
      const index = CAUSE_SIGNALS.findIndex((pattern) => pattern.test(line));
      return index < 0 ? CAUSE_SIGNALS.length : index;
    };
    return [...lines].sort((a, b) => rank(a) - rank(b))[0] || '';
  }
  return message;
}

function formatGraphTime(timestamp) {
  if (!timestamp) return '';
  try {
    const date = new Date(timestamp);
    return `${date.getMonth() + 1}/${date.getDate()} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  } catch {
    return '';
  }
}

function formatUptime(seconds) {
  if (!seconds && seconds !== 0) return '\u2014';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h >= 24) return `${Math.floor(h / 24)}d ${h % 24}h`;
  return `${h}h ${m}m`;
}

function formatTelemetryTime(timestamp) {
  if (!timestamp) return null;
  const value = new Date(timestamp);
  if (Number.isNaN(value.getTime())) return null;
  return value.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function TelemetryState({ state, live = true }) {
  const status = state?.status || 'loading';
  const sampledTime = formatTelemetryTime(state?.sampledAt);
  const checkedTime = formatTelemetryTime(state?.checkedAt);

  // A stopped server stops reporting by design; an old sample is expected,
  // not a warning.
  if (!live && status !== 'error') {
    return (
      <div className="flex items-center gap-2 text-[11px] text-mil-muted">
        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-zinc-600" aria-hidden="true" />
        Not reporting while offline{sampledTime ? ` · last sample ${sampledTime}` : ''}
      </div>
    );
  }

  if (status === 'error') {
    return (
      <div role="alert" className="flex items-start gap-2 border border-red-500/25 bg-red-500/5 px-2.5 py-2 text-[11px] text-red-200">
        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <span>
          <strong className="font-semibold">Telemetry unavailable.</strong>{' '}
          {state?.message || 'The latest request failed.'}
          {checkedTime ? ` Checked ${checkedTime}.` : ''}
        </span>
      </div>
    );
  }

  if (status === 'stale') {
    return (
      <div className="flex items-start gap-2 border border-amber-500/25 bg-amber-500/5 px-2.5 py-2 text-[11px] text-amber-200">
        <Clock className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <span>
          <strong className="font-semibold">Telemetry stale.</strong>{' '}
          {sampledTime ? `Last sample ${sampledTime}.` : 'Showing the last known sample.'}
          {state?.message ? ` ${state.message}` : ''}
        </span>
      </div>
    );
  }

  if (status === 'fresh') {
    return (
      <div className="flex items-center gap-2 text-[11px] text-mil-muted">
        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-green-400" aria-hidden="true" />
        Telemetry fresh{sampledTime ? ` · sampled ${sampledTime}` : ''}{state?.refreshing ? ' · refreshing' : ''}
      </div>
    );
  }

  if (status === 'empty') {
    return (
      <div className="flex items-center gap-2 text-[11px] text-mil-muted">
        <RadioTower className="h-3.5 w-3.5 shrink-0" />
        Awaiting the first telemetry sample{checkedTime ? ` · checked ${checkedTime}` : ''}
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2 text-[11px] text-mil-muted">
      <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
      Requesting telemetry
    </div>
  );
}

function CustomTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="border border-[rgba(232,131,58,0.28)] bg-mil-bg-deep/95 px-3 py-2 text-xs shadow-lg">
      <p className="mb-1 text-brand" style={{ fontFamily: "var(--font-mono)" }}>{label}</p>
      {payload.map((entry) => (
        <div key={entry.dataKey} className="flex min-w-32 items-center justify-between gap-4">
          <span style={{ color: entry.color }}>{entry.name}</span>
          <span className="text-mil-fg">{entry.value ?? 'N/A'}</span>
        </div>
      ))}
    </div>
  );
}

function getNumericValues(series, key) {
  return series
    .map((item) => item[key])
    .filter((value) => Number.isFinite(value));
}

function getPaddedDomain(values, minimumSpan = 1) {
  if (!values.length) return [0, minimumSpan];
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (min === max) {
    const pad = Math.max(minimumSpan, Math.abs(max) * 0.15 || minimumSpan);
    return [Math.max(0, min - pad), max + pad];
  }
  const span = Math.max(max - min, minimumSpan);
  const pad = Math.max(minimumSpan * 0.2, span * 0.15);
  return [Math.max(0, min - pad), max + pad];
}

function StatBox({ icon: Icon, label, value, className = '' }) {
  return (
    <div className={`flex min-w-0 items-center gap-2 border border-[rgba(232,131,58,0.08)] bg-mil-bg-panel/80 px-3 py-2 ${className}`.trim()}>
      <Icon className="h-3.5 w-3.5 shrink-0 text-brand" aria-hidden="true" />
      <div className="min-w-0">
        <p className="truncate text-xs text-mil-muted font-medium capitalize">{label}</p>
        <p className="truncate text-sm font-semibold text-mil-fg">{value ?? '-'}</p>
      </div>
    </div>
  );
}

function MetricSparkline({ label, value, data, dataKey, color, emptyLabel }) {
  const prefersReducedMotion = useReducedMotion();
  const numericValues = getNumericValues(data, dataKey);
  const domain = getPaddedDomain(numericValues, dataKey === 'Players' ? 2 : 1);

  return (
    <div className="grid grid-cols-[64px_76px_1fr] items-center gap-3 border border-[rgba(232,131,58,0.08)] bg-mil-bg-deep/80 px-3 py-2">
      <span className="text-xs font-medium text-brand capitalize">{label}</span>
      <span className="text-sm font-semibold text-mil-fg">{value}</span>
      {numericValues.length < 2 ? (
        <div className="flex h-10 items-center justify-end text-[11px] text-zinc-500">
          {emptyLabel}
        </div>
      ) : (
        <MeasuredChartContainer
          className="h-10"
          minHeight={20}
          fallback={<div className="flex h-10 items-center justify-end text-[11px] text-zinc-500">Preparing chart</div>}
        >
          {({ width, height }) => (
            <LineChart width={width} height={height} data={data} margin={{ top: 4, right: 2, bottom: 4, left: 2 }}>
              <YAxis hide domain={domain} />
              <Tooltip content={<CustomTooltip />} />
              <Line
                type="monotone"
                dataKey={dataKey}
                name={label}
                stroke={color}
                strokeWidth={2}
                dot={numericValues.length <= 2 ? { r: 2 } : false}
                connectNulls
                isAnimationActive={!prefersReducedMotion}
                animationDuration={650}
              />
            </LineChart>
          )}
        </MeasuredChartContainer>
      )}
    </div>
  );
}

function ServerCard({ server, metrics, metricsState, pendingAction, onStart, onStop, onRestart, onPeriodChange, period = '1d', onNavigate }) {
  const prefersReducedMotion = useReducedMotion();
  if (!server) return null;

  const normalized = normalizeServer(server);
  const displayStatus = normalized.status === 'running' && isServerDegraded(normalized) ? 'degraded' : normalized.status;
  const { id, name, description } = normalized;
  const { glow, dotCls, label: statusLabel, badge } = getStatusVisuals(displayStatus);

  const latest = metrics?.latest;
  const timeseries = metrics?.timeseries;
  const hasTimeseries = Array.isArray(timeseries) && timeseries.length > 0;

  const graphData = hasTimeseries
    ? timeseries.map((point) => ({
        time: formatGraphTime(point.timestamp),
        FPS: point.fps ?? null,
        Players: point.player_count ?? null,
        Ping: point.ping ?? null,
      }))
    : [];

  // Live readings only exist while the game process is up; otherwise the
  // latest sample is history and must not read as a current value.
  const live = ['running', 'degraded', 'starting', 'stopping'].includes(normalized.status);
  const crashLooping = normalized.status === 'crash_loop';
  const failed = ['error', 'crash_loop'].includes(normalized.status);
  const cause = failed ? failureCause(normalized) : (crashLooping ? failureCause(normalized, { strict: true }) : '');
  const showFailure = Boolean(cause) || crashLooping;
  const liveValue = (value) => (live ? (value ?? 'Unavailable') : '—');

  const canStart = canStartServer(normalized);
  const canStop = canStopServer(normalized);
  const canRestart = canRestartServer(normalized);
  const showFooter = (canStart && onStart) || (canStop && onStop) || (canRestart && onRestart);

  const handleNavigate = (e) => {
    // Only intercept plain left-clicks; let Ctrl/Cmd/middle-click open in new tab
    if (onNavigate && e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      onNavigate(id, name);
    }
  };

  return (
    <motion.div
      layout
      initial={prefersReducedMotion ? false : { opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.24 }}
    >
    <Card
      className={`group relative flex flex-col overflow-hidden border-[rgba(232,131,58,0.14)] bg-mil-bg-deep/88 backdrop-blur-xs transition-all duration-200 hover:border-brand/35 hover:bg-[#111111] ${glow}`}
    >
      <div className="absolute inset-x-0 top-0 h-px bg-linear-to-r from-transparent via-brand-light/35 to-transparent" />
      <div className="pointer-events-none absolute inset-0 c2-noise opacity-0 transition-opacity group-hover:opacity-[0.08]" />
      <CardHeader className="pb-2">
        {/* Phones stack the badges under the name: side by side they left the
            name ~100px, so servers sharing a long prefix were
            indistinguishable. */}
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
          <Link to={`/servers/${id}`} onClick={handleNavigate} className="min-w-0 flex-1 rounded-sm focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-brand">
            <h3 className="line-clamp-2 break-words text-lg font-semibold leading-tight text-brand-light transition-colors group-hover:text-brand" style={{ fontFamily: "var(--font-heading)" }}>
              {name || 'Unnamed Server'}
            </h3>
          </Link>
          <div className="flex shrink-0 flex-row flex-wrap items-center gap-1.5 sm:flex-col sm:items-end">
            <span className={`inline-flex items-center gap-2 border px-2.5 py-1 text-[11px] font-semibold ${badge}`} style={{ fontFamily: "var(--font-condensed)" }}>
              <span className={dotCls} aria-hidden="true" />
              {statusLabel}
            </span>
          </div>
        </div>
        {description && (
          <p className="mt-2 line-clamp-2 text-xs text-mil-muted">{description}</p>
        )}
        <div className="mt-2 flex min-w-0 items-start gap-2 text-[11px] text-mil-dim" style={{ fontFamily: "var(--font-mono)" }}>
          <Box className="h-3 w-3 shrink-0" />
          <span className="wrap-break-word min-w-0">Runtime: {normalized.container_name || normalized.docker_image || 'metadata pending'}</span>
        </div>
      </CardHeader>

      <CardContent className="flex flex-1 flex-col gap-3 pb-3">
        {showFailure && (
          <div role="alert" className="border border-red-500/30 bg-red-500/[0.07] px-3 py-2.5 text-red-100">
            <div className="flex items-start gap-2">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-red-300" />
              <p className="min-w-0 text-xs leading-snug">
                <span className="font-semibold text-red-200">{crashLooping ? 'Crash loop' : 'Failed'}: </span>
                <span className="wrap-break-word text-red-100/85">{cause || 'repeated failed boots. Crash Analysis names the cause.'}</span>
              </p>
            </div>
            <Link
              to={`/servers/${id}/diagnosis`}
              className="mt-2 inline-flex min-h-9 items-center gap-1.5 border border-red-400/30 px-2.5 text-[11px] font-semibold text-red-200 transition-colors hover:bg-red-500/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-300"
              style={{ fontFamily: "var(--font-condensed)" }}
            >
              <Stethoscope className="h-3.5 w-3.5" /> Diagnose and fix
            </Link>
          </div>
        )}
        {normalized.status === 'deletion_pending' && normalized.last_docker_error && (
          <div role="alert" className="flex items-start gap-2 border border-amber-500/25 bg-amber-500/5 px-2.5 py-2 text-amber-200">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <div className="min-w-0 text-[11px] leading-snug">
              <p className="font-semibold">Deletion blocked</p>
              <p className="mt-0.5 wrap-break-word text-amber-100/75">{normalized.last_docker_error}</p>
            </div>
          </div>
        )}
        {/* Two columns on a phone with uptime on its own row ("Awaiting sample"
            does not fit a third of a 390px card); three from sm up. */}
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3" data-testid="server-card-stats">
          <StatBox icon={Users} label="Players" value={liveValue(latest?.player_count)} />
          <StatBox icon={Gauge} label="FPS" value={liveValue(latest?.server_fps ?? latest?.fps)} />
          <StatBox icon={Clock} label="Uptime" className="col-span-2 sm:col-span-1" value={live ? (latest?.uptime_seconds != null ? formatUptime(latest.uptime_seconds) : 'Awaiting sample') : 'Not running'} />
        </div>

        <TelemetryState state={metricsState} live={live} />

        {normalized.status === 'running' && latest?.uptime_seconds != null && latest.uptime_seconds > 48 * 3600 && (
          <div className="flex items-start gap-2 rounded border border-amber-500/20 bg-amber-500/5 px-2.5 py-2">
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-400" />
            <p className="text-[11px] leading-snug text-amber-300/90">
              Uptime exceeds 48 hours. A restart is recommended to prevent memory leaks and ensure stability.
            </p>
          </div>
        )}

        <div className="flex-1 border border-[rgba(232,131,58,0.08)] bg-zinc-900/35 p-2">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs text-mil-muted font-medium">
              Performance Trends
            </span>
            <div className="flex gap-1">
              {PERIODS.map((value) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={period === value}
                  aria-label={`Show ${value} telemetry for ${name}`}
                  disabled={Boolean(metricsState?.refreshing)}
                  onClick={() => onPeriodChange?.(id, value)}
                  className={`min-h-11 min-w-11 border px-2 py-0.5 text-[11px] font-medium transition-colors disabled:cursor-wait disabled:opacity-50 sm:min-h-8 sm:min-w-8 ${
                    period === value
                      ? 'border-[rgba(232,131,58,0.28)] bg-brand/15 text-brand'
                      : 'border-transparent text-zinc-500 hover:text-zinc-300'
                  }`}
                >
                  {value}
                </button>
              ))}
            </div>
          </div>

          {hasTimeseries ? (
            <div className="space-y-2">
              <MetricSparkline
                label="FPS"
                value={live && (latest?.server_fps != null || latest?.fps != null) ? `${latest?.server_fps ?? latest?.fps}` : '—'}
                data={graphData}
                dataKey="FPS"
                color="#22c55e"
                emptyLabel="Waiting for logStats samples"
              />
              <MetricSparkline
                label="Players"
                value={live && latest?.player_count != null ? `${latest.player_count}` : '—'}
                data={graphData}
                dataKey="Players"
                color="#e8833a"
                emptyLabel="Collecting player samples"
              />
            </div>
          ) : (
            <div className={`flex h-[120px] flex-col items-center justify-center border border-dashed px-4 text-center text-xs ${metricsState?.status === 'error' ? 'border-red-500/20 text-red-300' : 'border-[rgba(232,131,58,0.1)] text-mil-dim'}`}>
              <Gauge className="mb-2 h-5 w-5 text-mil-dim" />
              {metricsState?.status === 'error'
                ? 'Telemetry is unavailable'
                : metricsState?.status === 'empty'
                  ? 'No telemetry samples yet'
                  : ['fresh', 'stale'].includes(metricsState?.status)
                    // A latest sample exists but none fall inside this window
                    // (typically a stopped server); this used to sit on
                    // "Requesting telemetry" indefinitely.
                    ? `No samples in the last ${period}${period !== '30d' ? ' - try a longer period' : ''}`
                    : 'Requesting telemetry'}
            </div>
          )}
        </div>
      </CardContent>

      {showFooter && (
        <CardFooter className="flex-wrap gap-2 border-t border-brand-dark/10 pt-3">
          {canStart && onStart && (
            <Button
              variant="outline"
              size="sm"
              aria-label={pendingAction === 'start' ? `Starting ${name}` : `Start ${name}`}
              disabled={Boolean(pendingAction)}
              className="min-h-11 border-[rgba(232,131,58,0.4)] text-brand-light transition-colors hover:bg-brand/10 disabled:opacity-50"
              onClick={() => onStart(id)}
            >
              {pendingAction === 'start' ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Play className="mr-1 h-3.5 w-3.5" />}
              {pendingAction === 'start' ? 'Starting' : 'Start'}
            </Button>
          )}

          {canStop && onStop && (
            <Button
              variant="outline"
              size="sm"
              aria-label={pendingAction === 'stop' ? `Stopping ${name}` : `Stop ${name}`}
              disabled={Boolean(pendingAction)}
              className="min-h-11 border-red-700/40 text-red-300 transition-colors hover:bg-red-600/10 hover:text-red-200 disabled:opacity-50"
              onClick={() => onStop(id)}
            >
              {pendingAction === 'stop' ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Square className="mr-1 h-3.5 w-3.5" />}
              {pendingAction === 'stop' ? 'Stopping' : 'Stop'}
            </Button>
          )}

          {canRestart && onRestart && (
            <Button
              variant="outline"
              size="sm"
              aria-label={pendingAction === 'restart' ? `Restarting ${name}` : `Restart ${name}`}
              disabled={Boolean(pendingAction)}
              className="min-h-11 border-white/10 text-mil-soft transition-colors hover:border-[rgba(232,131,58,0.35)] hover:text-brand-light disabled:opacity-50"
              onClick={() => onRestart(id)}
            >
              {pendingAction === 'restart' ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="mr-1 h-3.5 w-3.5" />}
              {pendingAction === 'restart' ? 'Restarting' : 'Restart'}
            </Button>
          )}
        </CardFooter>
      )}
    </Card>
    </motion.div>
  );
}

export default ServerCard;
