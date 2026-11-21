import { describe, expect, it } from 'vitest';

import { titleCase } from './titleCase';

describe('titleCase', () => {
  it('sets stored capitals in title case', () => {
    expect(titleCase('SERVER / RCON CONSOLE')).toBe('Server / RCON Console');
    expect(titleCase('MOD LOAD ORDER')).toBe('Mod Load Order');
    expect(titleCase()).toBe('');
  });

  it('keeps acronyms in capitals', () => {
    expect(titleCase('FPS HISTORY')).toBe('FPS History');
    expect(titleCase('sat')).toBe('SAT');
    expect(titleCase('rcon')).toBe('RCON');
  });
});
