import { describe, expect, test } from 'vitest';

import { applyJsonEdits, flattenForForm, locateJsonValues } from './jsonTextPatch';

// Verbatim from the live Server 1 profile tree — the exact formatting quirks
// (a lone comma on its own line, `60.0` float literals) are the reason this
// module exists rather than a JSON.parse/stringify round-trip.
const SHS_DRIVEBY = `{
  "enabled": true,

  "helicopter": {
    "allow_rifles": true,
    "allow_launchers": false,
    "allow_grenades": false
,

    "armored": {
      "allow_rifles": true,
      "allow_grenades": false
    }
  },

  "wheeled": {
    "allow_rifles": true,
    "allow_grenades": false
  }
}`;

const FOV_SETTINGS = `{
    "m_bEnabled": true,
    "m_fMinFOV": 60.0,
    "m_fMaxFOV": 90.0,
    "m_fZoomAmount": 0.6600000262260437
}`;

describe('locateJsonValues', () => {
  test('finds nested paths', () => {
    const spans = locateJsonValues(SHS_DRIVEBY);
    expect(spans.has('helicopter.allow_grenades')).toBe(true);
    expect(spans.has('helicopter.armored.allow_grenades')).toBe(true);
    expect(spans.has('wheeled.allow_grenades')).toBe(true);
  });

  test('distinguishes the same key under different parents', () => {
    // The whole reason this is a parser and not a regex.
    const spans = locateJsonValues(SHS_DRIVEBY);
    const heli = spans.get('helicopter.allow_grenades');
    const wheeled = spans.get('wheeled.allow_grenades');
    expect(heli.start).not.toBe(wheeled.start);
  });

  test('a span covers exactly the value text', () => {
    const spans = locateJsonValues(FOV_SETTINGS);
    const span = spans.get('m_fMinFOV');
    expect(FOV_SETTINGS.slice(span.start, span.end)).toBe('60.0');
  });

  test('indexes array elements', () => {
    const spans = locateJsonValues('{"admins": ["a", "b"]}');
    expect(spans.has('admins[0]')).toBe(true);
    expect(spans.has('admins[1]')).toBe(true);
  });

  test('handles escaped quotes in strings', () => {
    const text = '{"note": "say \\"hi\\"", "next": 1}';
    const spans = locateJsonValues(text);
    expect(spans.has('next')).toBe(true);
    const span = spans.get('note');
    expect(text.slice(span.start, span.end)).toBe('"say \\"hi\\""');
  });

  test('handles empty objects and arrays', () => {
    const spans = locateJsonValues('{"a": {}, "b": [], "c": 1}');
    expect(spans.has('a')).toBe(true);
    expect(spans.has('b')).toBe(true);
    expect(spans.has('c')).toBe(true);
  });
});

describe('applyJsonEdits', () => {
  test('changes only the edited value and leaves every other byte identical', () => {
    const { text, applied } = applyJsonEdits(SHS_DRIVEBY, [
      { path: 'helicopter.allow_grenades', value: true },
    ]);
    expect(applied).toEqual(['helicopter.allow_grenades']);
    expect(JSON.parse(text).helicopter.allow_grenades).toBe(true);
    // The unusual formatting survives untouched.
    expect(text).toContain('\n,\n');

    // Exactly one line differs, and it is the one that was edited.
    const before = SHS_DRIVEBY.split('\n');
    const after = text.split('\n');
    expect(after).toHaveLength(before.length);
    const changed = after
      .map((line, i) => (line === before[i] ? null : i))
      .filter((i) => i !== null);
    expect(changed).toHaveLength(1);
    expect(after[changed[0]]).toContain('allow_grenades');
  });

  test('does NOT rewrite untouched float literals — the 60.0 problem', () => {
    const { text } = applyJsonEdits(FOV_SETTINGS, [{ path: 'm_bEnabled', value: false }]);
    expect(text).toContain('"m_fMinFOV": 60.0');
    expect(text).toContain('"m_fMaxFOV": 90.0');
    expect(text).toContain('0.6600000262260437');
    // A JSON.stringify round-trip would have produced 60 and 90.
    expect(JSON.stringify(JSON.parse(FOV_SETTINGS))).not.toContain('60.0');
  });

  test('applies several edits at once', () => {
    const { text, applied } = applyJsonEdits(SHS_DRIVEBY, [
      { path: 'enabled', value: false },
      { path: 'helicopter.allow_rifles', value: false },
      { path: 'wheeled.allow_grenades', value: true },
    ]);
    expect(applied).toHaveLength(3);
    const parsed = JSON.parse(text);
    expect(parsed.enabled).toBe(false);
    expect(parsed.helicopter.allow_rifles).toBe(false);
    expect(parsed.wheeled.allow_grenades).toBe(true);
    // Untouched siblings keep their values.
    expect(parsed.helicopter.armored.allow_rifles).toBe(true);
  });

  test('edits stay correct when spans shift — later edits do not corrupt earlier ones', () => {
    // Replacing a short value with a long one earlier in the file would break
    // any later span if edits were applied front-to-back.
    const source = '{"a": 1, "b": 2, "c": 3}';
    const { text } = applyJsonEdits(source, [
      { path: 'a', value: 'a-much-longer-value' },
      { path: 'c', value: 999 },
    ]);
    expect(JSON.parse(text)).toEqual({ a: 'a-much-longer-value', b: 2, c: 999 });
  });

  test('edits the right one of two identically-named keys', () => {
    const { text } = applyJsonEdits(SHS_DRIVEBY, [
      { path: 'wheeled.allow_grenades', value: true },
    ]);
    const parsed = JSON.parse(text);
    expect(parsed.wheeled.allow_grenades).toBe(true);
    expect(parsed.helicopter.allow_grenades).toBe(false);
    expect(parsed.helicopter.armored.allow_grenades).toBe(false);
  });

  test('reports paths it could not find instead of dropping them silently', () => {
    const { applied, missing } = applyJsonEdits(SHS_DRIVEBY, [
      { path: 'enabled', value: false },
      { path: 'does.not.exist', value: 1 },
    ]);
    expect(applied).toEqual(['enabled']);
    expect(missing).toEqual(['does.not.exist']);
  });

  test('writes string values as valid JSON', () => {
    const { text } = applyJsonEdits('{"webhook_url": "old"}', [
      { path: 'webhook_url', value: 'https://example.test/a"b' },
    ]);
    expect(JSON.parse(text).webhook_url).toBe('https://example.test/a"b');
  });

  test('an empty edit list returns the text unchanged', () => {
    expect(applyJsonEdits(SHS_DRIVEBY, []).text).toBe(SHS_DRIVEBY);
  });
});

describe('flattenForForm', () => {
  test('produces one entry per scalar leaf', () => {
    const flat = flattenForForm(JSON.parse(SHS_DRIVEBY));
    const paths = flat.map((e) => e.path);
    expect(paths).toContain('enabled');
    expect(paths).toContain('helicopter.allow_grenades');
    expect(paths).toContain('helicopter.armored.allow_rifles');
  });

  test('keeps arrays whole rather than exploding them into indexes', () => {
    const flat = flattenForForm({ admins: ['a', 'b'] });
    expect(flat).toHaveLength(1);
    expect(flat[0].isArray).toBe(true);
    expect(flat[0].path).toBe('admins');
  });

  test('carries the value type through so the form can pick a control', () => {
    const flat = flattenForForm({ on: true, count: 3, name: 'x' });
    expect(flat.find((e) => e.path === 'on').value).toBe(true);
    expect(flat.find((e) => e.path === 'count').value).toBe(3);
    expect(flat.find((e) => e.path === 'name').value).toBe('x');
  });
});
