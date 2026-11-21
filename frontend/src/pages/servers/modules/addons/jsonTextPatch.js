/**
 * Surgical JSON editing that preserves the bytes you did not touch.
 *
 * These are addon-authored config files, not ours. Round-tripping them through
 * `JSON.parse` → `JSON.stringify` rewrites the whole file: `60.0` in
 * FovAndZoomSettings.json becomes `60`, key order is only preserved by luck,
 * and the odd hand-formatting in shs_driveby.json (a lone `,` on its own line)
 * is reflowed. None of that is *invalid*, but it turns a one-toggle change into
 * a whole-file diff and makes it impossible to tell what an operator actually
 * changed.
 *
 * So a form edit rewrites only the span of the value it changed, leaving every
 * other byte identical.
 *
 * The scanner is a position-tracking JSON reader rather than a regex, because
 * paths repeat across a config (`helicopter.allow_grenades` and
 * `wheeled.allow_grenades`) and only structure can tell them apart.
 */

const WHITESPACE = /\s/;

/**
 * Map every value in `text` to its character span.
 *
 * @param {string} text valid JSON
 * @returns {Map<string, {start: number, end: number}>} dotted path → span.
 *   Array elements use `path[0]` form. The root is the empty string.
 */
export function locateJsonValues(text) {
  const spans = new Map();
  let i = 0;

  const skipWhitespace = () => {
    while (i < text.length && WHITESPACE.test(text[i])) i += 1;
  };

  const readString = () => {
    i += 1; // opening quote
    while (i < text.length) {
      if (text[i] === '\\') { i += 2; continue; }
      if (text[i] === '"') { i += 1; return; }
      i += 1;
    }
  };

  const readPrimitive = () => {
    // A number, true, false, or null: runs until a structural character.
    while (i < text.length && !/[,}\]\s]/.test(text[i])) i += 1;
  };

  const readObject = (path) => {
    i += 1; // {
    skipWhitespace();
    if (text[i] === '}') { i += 1; return; }
    while (i < text.length) {
      skipWhitespace();
      if (text[i] !== '"') return; // malformed; stop rather than loop
      const keyStart = i;
      readString();
      let key;
      try {
        key = JSON.parse(text.slice(keyStart, i));
      } catch {
        return;
      }
      skipWhitespace();
      if (text[i] !== ':') return;
      i += 1;
      // eslint-disable-next-line no-use-before-define
      readValue(path ? `${path}.${key}` : String(key));
      skipWhitespace();
      if (text[i] === ',') { i += 1; continue; }
      if (text[i] === '}') { i += 1; return; }
      return;
    }
  };

  const readArray = (path) => {
    i += 1; // [
    skipWhitespace();
    if (text[i] === ']') { i += 1; return; }
    let index = 0;
    while (i < text.length) {
      // eslint-disable-next-line no-use-before-define
      readValue(`${path}[${index}]`);
      index += 1;
      skipWhitespace();
      if (text[i] === ',') { i += 1; continue; }
      if (text[i] === ']') { i += 1; return; }
      return;
    }
  };

  function readValue(path) {
    skipWhitespace();
    const start = i;
    const ch = text[i];
    if (ch === '{') readObject(path);
    else if (ch === '[') readArray(path);
    else if (ch === '"') readString();
    else readPrimitive();
    spans.set(path, { start, end: i });
  }

  readValue('');
  return spans;
}

/**
 * Rewrite the values at the given paths, leaving all other bytes untouched.
 *
 * @param {string} text original file contents
 * @param {Array<{path: string, value: any}>} edits
 * @returns {{text: string, applied: string[], missing: string[]}}
 *   `missing` lists paths that could not be located — callers should fall back
 *   to a full re-serialize rather than silently dropping an edit.
 */
export function applyJsonEdits(text, edits) {
  const spans = locateJsonValues(text);
  const applied = [];
  const missing = [];

  const resolved = [];
  for (const edit of edits) {
    const span = spans.get(edit.path);
    if (!span) {
      missing.push(edit.path);
      continue;
    }
    resolved.push({ span, value: edit.value, path: edit.path });
  }

  // Apply back-to-front so earlier spans keep their offsets.
  resolved.sort((a, b) => b.span.start - a.span.start);

  let out = text;
  for (const { span, value, path } of resolved) {
    out = out.slice(0, span.start) + JSON.stringify(value) + out.slice(span.end);
    applied.push(path);
  }

  return { text: out, applied, missing };
}

/** Flatten a parsed config to dotted paths → scalar values, for form rendering. */
export function flattenForForm(value, prefix = '') {
  const out = [];
  if (value === null || typeof value !== 'object') {
    out.push({ path: prefix, value });
    return out;
  }
  if (Array.isArray(value)) {
    // Arrays are edited as raw JSON rather than element-by-element: addon
    // arrays are lists (admin ids, mission rotations) where inserting is the
    // normal edit, and a per-index form makes that awkward.
    out.push({ path: prefix, value, isArray: true });
    return out;
  }
  for (const [key, child] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    out.push(...flattenForForm(child, path));
  }
  return out;
}

export default applyJsonEdits;
