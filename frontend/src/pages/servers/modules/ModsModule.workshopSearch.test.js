import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const directory = fileURLToPath(new URL('.', import.meta.url));
const source = readFileSync(new URL('ModsModule.jsx', `file:///${directory.replaceAll('\\', '/')}/`), 'utf8');

describe('ModsModule Workshop search contract', () => {
  test('debounces query changes and sends the cache lookup with the query, page, and indexed page size', () => {
    expect(source).toContain('useDebouncedValue(workshopSearch, 450)');
    expect(source).toContain('useDebouncedValue(workshopTags, 450)');
    expect(source).toContain("apiClient.get('/servers/workshop/search', {");
    expect(source).toContain('params: { q: query, page: workshopPage, per_page: 16 }');
  });

  test('batches page resets with debounced criteria instead of firing a stale-page request first', () => {
    expect(source).toContain('setWorkshopTagQuery(debouncedWorkshopTags.trim())');
    expect(source).not.toContain('}, [workshopQuery, workshopSort, workshopTags]);');
  });

  test('shows cached results while the live lookup is pending and keeps them when it fails', () => {
    const cacheBeforeLive = source.indexOf("setWorkshopSource('cache')") < source.indexOf("await apiClient.get('/workshop/search'");
    expect(cacheBeforeLive).toBe(true);
    expect(source).toContain("'Live Workshop search is unavailable. Showing indexed results.'");
    expect(source).toContain("setWorkshopSource(cachedMods.length > 0 ? 'cache' : 'error')");
  });

  test('does not let an older live response overwrite a newer query', () => {
    expect(source).toContain('const requestId = ++workshopRequestIdRef.current;');
    expect(source).toContain('if (requestId !== workshopRequestIdRef.current) return;');
  });
});
