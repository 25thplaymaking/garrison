import { describe, expect, test } from 'vitest';

import { filterRevisions, revisionSearchText } from './revisionFilters';

const REVISIONS = [
  {
    version: 192,
    source: 'import',
    changed_by_name: 'rook',
    diff: {
      added: [
        { mod_id: '69623A037A721B91', name: 'ThermalPostProcessAssets' },
        { mod_id: '65DC31F1140DF158', name: 'Bradley Optics Upgrade' },
      ],
      removed: [],
    },
  },
  {
    version: 191,
    source: 'deploy',
    changed_by_name: 'kestrel',
    diff: {
      removed: [{ mod_id: '58D8C77E', name: 'RHS Status Quo' }],
      moved: [{ mod_id: 'ACE1', name: 'ACE Core', from: 31, to: 4 }],
    },
  },
  {
    version: 190,
    source: 'mirror',
    changed_by_name: 'kestrel',
    diff: { version_changed: [{ mod_id: 'HAL1', name: 'Alpha Core', from: '1.0', to: '1.1' }] },
  },
];

describe('revisionSearchText', () => {
  test('includes the mod names and ids inside the diff', () => {
    const text = revisionSearchText(REVISIONS[0]);
    expect(text).toContain('bradley optics upgrade');
    expect(text).toContain('69623a037a721b91');
  });

  test('includes the version, source, and author', () => {
    const text = revisionSearchText(REVISIONS[1]);
    expect(text).toContain('revision 191');
    expect(text).toContain('deploy');
    expect(text).toContain('kestrel');
  });

  test('covers every diff bucket, including moves', () => {
    expect(revisionSearchText(REVISIONS[1])).toContain('ace core');
    expect(revisionSearchText(REVISIONS[2])).toContain('alpha core');
  });

  test('tolerates a missing or empty diff', () => {
    expect(revisionSearchText({ version: 1 })).toContain('revision 1');
    expect(revisionSearchText({})).toBe('revision ');
    expect(() => revisionSearchText(null)).not.toThrow();
  });
});

describe('filterRevisions', () => {
  test('returns everything for an empty query', () => {
    expect(filterRevisions(REVISIONS, '')).toHaveLength(3);
    expect(filterRevisions(REVISIONS, '  ')).toHaveLength(3);
    expect(filterRevisions(REVISIONS, null)).toHaveLength(3);
  });

  test('finds the revision that touched a given mod — the point of the feature', () => {
    // "when did we add Bradley Optics" has to match on diff contents, not just
    // the row header.
    const result = filterRevisions(REVISIONS, 'bradley');
    expect(result.map((r) => r.version)).toEqual([192]);
  });

  test('finds a removal by mod name', () => {
    expect(filterRevisions(REVISIONS, 'rhs').map((r) => r.version)).toEqual([191]);
  });

  test('finds a move by mod name', () => {
    expect(filterRevisions(REVISIONS, 'ace core').map((r) => r.version)).toEqual([191]);
  });

  test('filters by person', () => {
    expect(filterRevisions(REVISIONS, 'rook').map((r) => r.version)).toEqual([192]);
    expect(filterRevisions(REVISIONS, 'kestrel').map((r) => r.version)).toEqual([191, 190]);
  });

  test('filters by source', () => {
    expect(filterRevisions(REVISIONS, 'mirror').map((r) => r.version)).toEqual([190]);
  });

  test('filters by revision number', () => {
    expect(filterRevisions(REVISIONS, 'revision 190').map((r) => r.version)).toEqual([190]);
  });

  test('requires all terms, so extra words narrow', () => {
    expect(filterRevisions(REVISIONS, 'kestrel').map((r) => r.version)).toEqual([191, 190]);
    expect(filterRevisions(REVISIONS, 'kestrel mirror').map((r) => r.version)).toEqual([190]);
  });

  test('is case insensitive', () => {
    expect(filterRevisions(REVISIONS, 'BRADLEY')).toHaveLength(1);
  });

  test('returns nothing when nothing matches', () => {
    expect(filterRevisions(REVISIONS, 'zzz')).toEqual([]);
  });

  test('tolerates a null list', () => {
    expect(filterRevisions(null, 'x')).toEqual([]);
    expect(filterRevisions(undefined, '')).toEqual([]);
  });
});
