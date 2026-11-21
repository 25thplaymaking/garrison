import { describe, expect, it } from 'vitest';
import {
  configHistoryFrom,
  configHistoryTotalFrom,
  latestRevisionFrom,
} from './configHistory';

const revision = { version: 2, changed_at: '2026-07-28T10:00:00Z', changed_by: 'warden' };

describe('configHistoryFrom', () => {
  it('reads the paginated envelope the endpoint returns today', () => {
    expect(configHistoryFrom({
      items: [revision],
      total: 1,
      limit: 50,
      offset: 0,
      has_more: false,
    })).toEqual([revision]);
  });

  it('returns an array for an empty page instead of the envelope itself', () => {
    // The regression: `data.history || data` handed the envelope to state, and
    // rendering `.map` over an object crashed the whole Server tab.
    const result = configHistoryFrom({ items: [], total: 0, limit: 50, offset: 0, has_more: false });
    expect(Array.isArray(result)).toBe(true);
    expect(result).toEqual([]);
  });

  it('still accepts the bare array the endpoint used to return', () => {
    expect(configHistoryFrom([revision])).toEqual([revision]);
    expect(configHistoryTotalFrom([revision])).toBe(1);
  });

  it('gives an empty array for a failed or malformed response', () => {
    for (const value of [null, undefined, '', 'nope', 42, {}, { items: null }]) {
      expect(configHistoryFrom(value)).toEqual([]);
      expect(configHistoryTotalFrom(value)).toBe(0);
    }
  });

  it('uses the envelope total instead of the loaded page size', () => {
    expect(configHistoryTotalFrom({
      items: [revision],
      total: 225,
      limit: 50,
      offset: 0,
      has_more: true,
    })).toBe(225);
  });
});

describe('latestRevisionFrom', () => {
  it('takes the version of the newest entry, not the entry count', () => {
    // History is newest-first, and pruning must never rewind the token.
    expect(latestRevisionFrom({ items: [{ version: 91 }, { version: 90 }], total: 2 })).toBe(91);
  });

  it('reads the bare-array shape too', () => {
    expect(latestRevisionFrom([{ version: 7 }])).toBe(7);
  });

  it('is 0 for a server with no history yet', () => {
    expect(latestRevisionFrom({ items: [], total: 0 })).toBe(0);
  });

  it('is 0 rather than NaN when the version is missing or junk', () => {
    for (const items of [[{}], [{ version: null }], [{ version: 'x' }]]) {
      expect(latestRevisionFrom({ items })).toBe(0);
    }
    expect(latestRevisionFrom(null)).toBe(0);
  });
});
