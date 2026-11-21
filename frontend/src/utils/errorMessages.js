/**
 * Extract a human-readable error message from an API error response.
 *
 * FastAPI / Pydantic v2 validation errors return `detail` as an array of
 * objects.  This helper collapses them into a single readable string so
 * callers can simply `alert(formatApiError(err, 'Something went wrong'))`.
 */
export function formatApiError(err, fallback = 'An error occurred') {
  const detail = err?.response?.data?.detail;
  if (Array.isArray(detail)) {
    return detail
      .map((e) => e.msg || e.message || JSON.stringify(e))
      .join('; ');
  }
  if (detail && typeof detail === 'object') {
    // Structured details ({ message, ... }) must never reach React as an object.
    return detail.message || detail.msg || fallback;
  }
  return detail || fallback;
}
