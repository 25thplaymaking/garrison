export function normalizeServer(server) {
  if (!server) return server;

  const next = { ...server };

  if (next.status === 'provisioning_partial') {
    next.status = 'running';
    next.deployment_state = next.deployment_state || 'created';
    next.provisioning_state = 'warning';
    // Only degrade readiness if there are non-SAT/non-profile provisioning
    // warnings — supplemental tooling failures should not poison readiness.
    if (!next.readiness_state) {
      const warnings = next.provisioning_warnings || [];
      const hasRealWarnings = warnings.some(
        (w) => w.stage !== 'sat_discovery' && w.stage !== 'profile_generation',
      );
      next.readiness_state = hasRealWarnings ? 'degraded' : 'ready';
    }
  }

  if (next.status === 'provisioning_failed') {
    next.status = 'error';
    next.deployment_state = 'failed';
    next.provisioning_state = 'failed';
    next.readiness_state = 'failed';
  }

  if (!next.deployment_state) {
    next.deployment_state = next.status === 'error' ? 'failed' : 'created';
  }

  if (next.status === 'running' && next.provisioning_state === 'warning' && !next.readiness_state) {
    // Same check: only degrade for real operational warnings.
    const warnings = next.provisioning_warnings || [];
    const hasRealWarnings = warnings.some(
      (w) => w.stage !== 'sat_discovery' && w.stage !== 'profile_generation',
    );
    next.readiness_state = hasRealWarnings ? 'degraded' : 'ready';
  }

  return next;
}

// Mongo returns UTC datetimes without tzinfo and older endpoints serialise
// them with no offset ("2026-10-10T21:12:27"), which `new Date()` reads as the
// viewer's local time. Treat an offset-less ISO timestamp as UTC.
const ISO_WITHOUT_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/;

export function parseServerDate(value) {
  if (value == null || value === '') return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const text = String(value);
  const date = new Date(ISO_WITHOUT_ZONE.test(text) ? `${text}Z` : text);
  return Number.isNaN(date.getTime()) ? null : date;
}

// The record keeps two messages: `summary_message` is written by provisioning
// and crash-loop detection, `last_docker_error` by every start/stop/restart
// failure and the health monitor. Once a server is in a failed state the most
// recent action's error is the one that explains it; the summary can be days
// old (a crash-loop text shown after a Docker outage sent operators chasing an
// engine error that had nothing to do with the failed start).
export function currentFailureMessage(server) {
  if (!server) return '';
  const failed = ['error', 'crash_loop', 'provisioning_failed'].includes(server.status);
  const message = failed
    ? (server.last_docker_error || server.summary_message)
    : (server.summary_message || server.last_docker_error);
  return String(message || '').trim();
}

export function isServerDegraded(server) {
  const normalized = normalizeServer(server);
  if (!normalized) return false;
  return normalized.readiness_state === 'degraded' || normalized.provisioning_state === 'warning';
}

export function getOperationalSummary(server) {
  const normalized = normalizeServer(server);
  if (!normalized) {
    return {
      state: 'unknown',
      label: 'UNKNOWN',
      detail: 'Status could not be determined.',
    };
  }

  if (normalized.status === 'running' && isServerDegraded(normalized)) {
    return {
      state: 'degraded',
      label: 'RUNNING WITH ATTENTION',
      detail: normalized.summary_message || 'Server deployment succeeded, but one or more follow-up stages need attention.',
    };
  }

  if (normalized.deployment_state === 'created' && ['queued', 'running'].includes(normalized.provisioning_state)) {
    return {
      state: 'created',
      label: 'DEPLOYED',
      detail: normalized.summary_message || 'Server deployment succeeded and first-boot provisioning is still running.',
    };
  }

  if (normalized.status === 'running') {
    return {
      state: 'running',
      label: 'OPERATIONAL',
      detail: 'Server is live and reporting a healthy runtime state.',
    };
  }

  if (normalized.status === 'error') {
    return {
      state: 'error',
      label: 'ERROR',
      detail: currentFailureMessage(normalized) || 'Creation or startup failed before the server became operational.',
    };
  }

  return {
    state: normalized.status,
    label: String(normalized.status || 'unknown').replace(/_/g, ' ').toUpperCase(),
    detail: normalized.summary_message || normalized.last_docker_error || 'Server state is updating.',
  };
}

export function canStartServer(server) {
  const normalized = normalizeServer(server);
  return ['created', 'stopped', 'error', 'crash_loop'].includes(normalized?.status);
}

export function canStopServer(server) {
  const normalized = normalizeServer(server);
  return ['running', 'starting', 'initializing'].includes(normalized?.status);
}

export function canRestartServer(server) {
  const normalized = normalizeServer(server);
  return normalized?.status === 'running';
}
