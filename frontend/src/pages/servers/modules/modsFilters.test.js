import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

import { filterLoadOrder, isFilterActive } from './modsFilters';

const directory = fileURLToPath(new URL('.', import.meta.url));
const source = readFileSync(
  new URL('ModsModule.jsx', `file:///${directory.replaceAll('\\', '/')}/`),
  'utf8',
);

const mod = (name, extra = {}) => ({ name, mod_id: `ID_${name}`, enabled: true, ...extra });

const LOADOUT = [
  mod('Base Game Data'),
  mod('Alpha Core', { version: '1.4.2', author: 'Warden' }),
  mod('RHS Status Quo', { tags: ['weapons', 'vehicles'] }),
  mod('Alpha Vehicles'),
  mod('ACE Core'),
];

describe('filterLoadOrder', () => {
  test('returns every mod with its index when the query is empty', () => {
    const result = filterLoadOrder(LOADOUT, '');
    expect(result).toHaveLength(5);
    expect(result.map((e) => e.index)).toEqual([0, 1, 2, 3, 4]);
  });

  test('treats whitespace-only queries as empty', () => {
    expect(filterLoadOrder(LOADOUT, '   ')).toHaveLength(5);
  });

  test('PRESERVES the absolute index of each match', () => {
    // The whole reason this is a pure function: a filtered row must still
    // reorder/toggle/remove the mod at its ORIGINAL position.
    const result = filterLoadOrder(LOADOUT, 'alpha');
    expect(result.map((e) => e.index)).toEqual([1, 3]);
    expect(result.map((e) => e.mod.name)).toEqual(['Alpha Core', 'Alpha Vehicles']);
  });

  test('matches case-insensitively', () => {
    expect(filterLoadOrder(LOADOUT, 'ALPHA')).toHaveLength(2);
  });

  test('matches on mod id', () => {
    const result = filterLoadOrder(LOADOUT, 'ID_ACE Core');
    expect(result.map((e) => e.index)).toEqual([4]);
  });

  test('matches on version', () => {
    expect(filterLoadOrder(LOADOUT, '1.4.2').map((e) => e.index)).toEqual([1]);
  });

  test('matches on author', () => {
    expect(filterLoadOrder(LOADOUT, 'warden').map((e) => e.index)).toEqual([1]);
  });

  test('matches on tags, including array tags', () => {
    expect(filterLoadOrder(LOADOUT, 'weapons').map((e) => e.index)).toEqual([2]);
  });

  test('requires ALL terms to match, so extra words narrow the list', () => {
    expect(filterLoadOrder(LOADOUT, 'alpha').map((e) => e.index)).toEqual([1, 3]);
    expect(filterLoadOrder(LOADOUT, 'alpha vehicles').map((e) => e.index)).toEqual([3]);
  });

  test('terms may match different fields of the same mod', () => {
    expect(filterLoadOrder(LOADOUT, 'alpha warden').map((e) => e.index)).toEqual([1]);
  });

  test('returns nothing when no mod matches', () => {
    expect(filterLoadOrder(LOADOUT, 'nonexistent')).toEqual([]);
  });

  test('tolerates a null list and null fields', () => {
    expect(filterLoadOrder(null, 'x')).toEqual([]);
    expect(filterLoadOrder(undefined, '')).toEqual([]);
    expect(filterLoadOrder([{ name: null, mod_id: null }], 'x')).toEqual([]);
  });

  test('tolerates a null query', () => {
    expect(filterLoadOrder(LOADOUT, null)).toHaveLength(5);
  });
});

describe('isFilterActive', () => {
  test('is false for empty, whitespace, and nullish queries', () => {
    expect(isFilterActive('')).toBe(false);
    expect(isFilterActive('   ')).toBe(false);
    expect(isFilterActive(null)).toBe(false);
    expect(isFilterActive(undefined)).toBe(false);
  });

  test('is true once there is a real term', () => {
    expect(isFilterActive('a')).toBe(true);
  });
});

describe('ModsModule Load Order search wiring', () => {
  test('renders from the filtered entries, destructuring the preserved index', () => {
    expect(source).toContain('visibleLoadOrder.map(({ mod, index }) =>');
  });

  test('drag is disabled while a filter is active', () => {
    // Dropping between two visible rows is ambiguous when mods are hidden
    // between them; arrows and the position box stay live instead.
    expect(source).toContain('draggable={!mod.system_managed && canManage && !loadOrderFiltered}');
    expect(source).toContain('disabled={mod.system_managed || !canManage || loadOrderFiltered}');
  });

  test('the arrow controls still bound against the FULL list, not the filtered one', () => {
    // enabledMods.length here, not visibleLoadOrder.length — otherwise the last
    // visible row would refuse to move down while filtered.
    expect(source).toContain('disabled={index === enabledMods.length - 1}');
  });

  test('the position box is capped by the full list length', () => {
    expect(source).toContain('max={enabledMods.length}');
  });

  test('shows a match count and a clear control', () => {
    expect(source).toContain('of ${enabledMods.length} shown');
    expect(source).toContain("setLoadOrderSearch('')");
  });
});
