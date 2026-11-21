/**
 * 'SERVER / RCON CONSOLE' -> 'Server / RCON Console'.
 *
 * Labels stored in capitals are set in title case so the interface doesn't
 * shout. Acronyms keep their capitals: "RCON Console", not "Rcon Console".
 */
const ACRONYMS = new Set(['RCON', 'SAT', 'FPS', 'CPU', 'RAM', 'API', 'JSON', 'URL', 'ID', 'UI', 'HQ', 'FAQ']);

export function titleCase(value = '') {
  return String(value)
    .split(/(\s+|\/)/)
    .map((word) => {
      if (!word.trim() || word === '/') return word;
      if (ACRONYMS.has(word.toUpperCase())) return word.toUpperCase();
      const lower = word.toLowerCase();
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join('');
}
