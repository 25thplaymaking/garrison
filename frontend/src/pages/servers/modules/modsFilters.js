/**
 * Load Order filtering.
 *
 * Kept as a pure function separate from ModsModule so the matching rules are
 * testable without mounting a 2000-line component.
 *
 * The critical detail is the shape of the result: every entry carries the mod's
 * ORIGINAL index. Reordering, toggling and removal are all index-based against
 * the full list, so a filtered view must never renumber — a row shown while
 * filtering has to move the same mod it would have moved unfiltered.
 */

/** Fields worth matching on. `dependency_of` is ids, which are searchable too. */
function haystack(mod) {
  return [
    mod?.name,
    mod?.mod_id,
    mod?.version,
    mod?.author,
    Array.isArray(mod?.tags) ? mod.tags.join(' ') : mod?.tags,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

/**
 * Filter `mods` by `query`, preserving each mod's absolute position.
 *
 * @returns {Array<{mod: object, index: number}>} original index preserved
 */
export function filterLoadOrder(mods, query) {
  const list = Array.isArray(mods) ? mods : [];
  const entries = list.map((mod, index) => ({ mod, index }));

  const trimmed = String(query ?? '').trim().toLowerCase();
  if (!trimmed) return entries;

  // Every whitespace-separated term must match somewhere, so "alpha vehicle"
  // narrows rather than widening the way an OR would.
  const terms = trimmed.split(/\s+/);
  return entries.filter(({ mod }) => {
    const text = haystack(mod);
    return terms.every((term) => text.includes(term));
  });
}

/** Whether a query is actually narrowing the list (drag is disabled when it is). */
export function isFilterActive(query) {
  return String(query ?? '').trim().length > 0;
}

export default filterLoadOrder;
