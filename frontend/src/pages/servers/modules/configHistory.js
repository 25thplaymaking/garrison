/**
 * `GET /servers/{id}/config/history` returns a page envelope —
 * `{items, total, limit, offset, has_more}` — since the revisions collection
 * replaced the embedded `config_history` array. Callers that still read it as
 * a bare array put the envelope itself into state, and rendering `.map` over
 * an object took the whole Server tab down with "x.map is not a function".
 *
 * Anything that is not recognisably a list of revisions becomes `[]`, so a
 * failed or reshaped response degrades to "no history" instead of a crash.
 */
export function configHistoryFrom(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.items)) return data.items;
  return [];
}

/**
 * The newest revision number in a history response, or 0 when there is none.
 *
 * This is the optimistic-concurrency token the config editor sends back as
 * `base_revision`. Taken from the newest entry's `version` rather than the
 * entry count — pruning history changes the count but must never rewind the
 * version, and a rewound token would wave a stale save straight through.
 */
export function latestRevisionFrom(data) {
  const [newest] = configHistoryFrom(data);
  const version = Number(newest?.version);
  return Number.isInteger(version) && version >= 0 ? version : 0;
}

export function configHistoryTotalFrom(data) {
  if (Number.isInteger(data?.total) && data.total >= 0) return data.total;
  return configHistoryFrom(data).length;
}
