/* Pure helpers + option constants shared by ServerDiagnostics tabs.
 *
 * Extracted from ServerDiagnostics.jsx to slim the main component.
 */

export function severityBadge(severity) {
  const map = {
    critical: 'bg-red-900/50 text-red-300 border-red-700/50',
    high: 'bg-orange-900/50 text-orange-300 border-orange-700/50',
    medium: 'bg-yellow-900/50 text-yellow-300 border-yellow-700/50',
    low: 'bg-blue-900/50 text-blue-300 border-blue-700/50',
  };
  return map[severity] || 'bg-zinc-900/50 text-zinc-300 border-zinc-700';
}

export function categoryBadge(category) {
  const map = {
    'backend-error': 'border-red-600/30 text-red-300',
    'addon-load': 'border-purple-600/30 text-purple-300',
    'fragmentizer': 'border-orange-600/30 text-orange-300',
    'script-error': 'border-indigo-600/30 text-indigo-300',
    'resource-error': 'border-cyan-600/30 text-cyan-300',
    'network-error': 'border-sky-600/30 text-sky-300',
    'world-error': 'border-green-600/30 text-green-300',
    'null-reference': 'border-amber-600/30 text-amber-300',
    'crash': 'border-red-600/30 text-red-300',
    'mod-mismatch': 'border-yellow-600/30 text-yellow-300',
    'config-error': 'border-teal-600/30 text-teal-300',
    'physics-error': 'border-blue-600/30 text-blue-300',
    'ai-error': 'border-violet-600/30 text-violet-300',
    'generic-error': 'border-zinc-600/30 text-zinc-300',
  };
  return map[category] || 'border-zinc-700 text-zinc-300';
}

export function confidenceColor(score) {
  if (score >= 0.8) return 'bg-red-600 text-white';
  if (score >= 0.5) return 'bg-yellow-600 text-black';
  return 'bg-[#7d7d7d] text-white';
}

export function modSeverityColor(severity) {
  const map = {
    critical: 'border-red-700/50 bg-red-900/40 text-red-200',
    high: 'border-orange-700/50 bg-orange-900/40 text-orange-200',
    medium: 'border-yellow-700/50 bg-yellow-900/40 text-yellow-200',
    low: 'border-blue-700/50 bg-blue-900/40 text-blue-200',
  };
  return map[severity] || 'border-zinc-700 bg-zinc-900/50 text-zinc-300';
}

export function statusColor(status) {
  const map = {
    active: 'bg-red-900/40 text-red-300 border-red-700/50',
    monitoring: 'bg-yellow-900/40 text-yellow-300 border-yellow-700/50',
    resolved: 'bg-green-900/40 text-green-300 border-green-700/50',
    false_positive: 'bg-mil-bg-elevated text-mil-muted border-[rgba(232,131,58,0.15)]',
  };
  return map[status] || 'bg-mil-bg-elevated text-mil-muted border-[rgba(232,131,58,0.15)]';
}

export function attributionTone(type) {
  const map = {
    mod: 'border-purple-600/30 text-purple-300',
    backend: 'border-red-600/30 text-red-300',
    base_game: 'border-blue-600/30 text-blue-300',
    engine: 'border-sky-600/30 text-sky-300',
    rcon: 'border-orange-600/30 text-orange-300',
    battleye: 'border-orange-600/30 text-orange-300',
    config: 'border-amber-600/30 text-amber-300',
    network: 'border-cyan-600/30 text-cyan-300',
    performance: 'border-rose-600/30 text-rose-300',
    unknown: 'border-zinc-700 text-zinc-300',
  };
  return map[type] || 'border-zinc-700 text-zinc-300';
}

export function actionabilityTone(actionability) {
  const map = {
    actionable: 'border-red-600/30 text-red-300',
    monitor: 'border-yellow-600/30 text-yellow-300',
    known_safe: 'border-zinc-700 text-zinc-300',
  };
  return map[actionability] || 'border-zinc-700 text-zinc-300';
}

export function areaTone(area) {
  const map = {
    'live-errors': 'border-red-600/30 text-red-300',
    'error-patterns': 'border-blue-600/30 text-blue-300',
    'mod-analysis': 'border-purple-600/30 text-purple-300',
    alerts: 'border-orange-600/30 text-orange-300',
    'troublesome-mods': 'border-rose-600/30 text-rose-300',
  };
  return map[area] || 'border-zinc-700 text-zinc-300';
}

export function sourceTone(category) {
  const map = {
    engine: 'border-blue-600/30 text-blue-300',
    config: 'border-amber-600/30 text-amber-300',
    'workshop-download': 'border-cyan-600/30 text-cyan-300',
    'mod-load': 'border-purple-600/30 text-purple-300',
    'runtime-script': 'border-indigo-600/30 text-indigo-300',
    'battleye-rcon': 'border-orange-600/30 text-orange-300',
    network: 'border-sky-600/30 text-sky-300',
    performance: 'border-red-600/30 text-red-300',
  };
  return map[category] || 'border-zinc-700 text-zinc-300';
}

export function fmtDate(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    return iso;
  }
}

export function humanizeToken(value) {
  if (!value) return 'Unknown';
  return String(value)
    .replace(/_/g, ' ')
    .replace(/-/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

export const VERDICT_OPTIONS = ['active', 'monitoring', 'resolved', 'false_positive'];
export const ACTIONABILITY_OPTIONS = ['actionable', 'monitor', 'known_safe'];
export const ATTRIBUTION_OPTIONS = [
  'unknown', 'mod', 'backend', 'base_game', 'engine', 'rcon',
  'battleye', 'config', 'network', 'performance',
];
export const AREA_OPTIONS = ['live-errors', 'error-patterns', 'mod-analysis', 'alerts', 'troublesome-mods'];
