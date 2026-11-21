/**
 * Revision-history search.
 *
 * Pure so the matching rules are testable without mounting the panel.
 *
 * Searching a changelog means searching what CHANGED, not just the row header —
 * "when did we add Bradley Optics" has to match the revision whose diff added
 * it. So the haystack folds in every mod name and id inside the diff alongside
 * the version, source, and the person who made the change.
 */

function diffModNames(diff) {
  const buckets = [
    diff?.added, diff?.removed, diff?.version_changed,
    diff?.enabled_changed, diff?.moved,
  ];
  const out = [];
  for (const bucket of buckets) {
    if (!Array.isArray(bucket)) continue;
    for (const mod of bucket) {
      if (mod?.name) out.push(mod.name);
      if (mod?.mod_id) out.push(mod.mod_id);
    }
  }
  return out;
}

/** The text a revision is matched against. Exported for testing. */
export function revisionSearchText(revision) {
  return [
    `revision ${revision?.version ?? ''}`,
    revision?.source,
    revision?.changed_by_name,
    ...diffModNames(revision?.diff),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

/** Filter revisions by a whitespace-separated, all-terms-must-match query. */
export function filterRevisions(revisions, query) {
  const list = Array.isArray(revisions) ? revisions : [];
  const trimmed = String(query ?? '').trim().toLowerCase();
  if (!trimmed) return list;

  const terms = trimmed.split(/\s+/);
  return list.filter((revision) => {
    const text = revisionSearchText(revision);
    return terms.every((term) => text.includes(term));
  });
}

export default filterRevisions;
