// Headings read in Title Case ("Command Center", not "Command center").
// Applied by the shared heading components to plain-text titles only,
// so member names and other content inside headings are never changed.
//
// Rules: every word starts with a capital, except short joining words (a, and,
// of, the ...) in the middle; a word already holding capitals (RCON, SAT,
// sUAS, ORBAT) is left alone; hyphenated words capitalize each part; web
// addresses stay as typed.

const MINOR = new Set([
  'a', 'an', 'and', 'as', 'at', 'but', 'by', 'for', 'from', 'if', 'in', 'into', 'nor', 'of', 'off', 'on', 'onto', 'or',
  'per', 'so', 'than', 'the', 'to', 'up', 'via', 'vs', 'vs.', 'with', 'yet',
]);

// The first letter only (after any leading "(" or quote); an existing capital stays.
const capitalizePart = (part) => part.replace(/^([^A-Za-z]*)([a-z])/, (_, pre, c) => pre + c.toUpperCase());

function fixWord(word, first, last) {
  if (!/[a-z]/.test(word)) return word;                       // numbers, symbols, ALL CAPS
  if (/[A-Z]/.test(word.slice(1)) || /^[a-z]+[A-Z]/.test(word)) return word; // RCON, SAT, iOS
  if (/[./@]\S/.test(word.replace(/[.,:;!?)]+$/, ''))) return word;       // example.com, a/b, @name
  const bare = word.replace(/^[^a-z]+|[^a-z.]+$/gi, '').toLowerCase();
  if (!first && !last && MINOR.has(bare)) return word.toLowerCase();
  return word.split('-').map(capitalizePart).join('-');
}

export function headingCase(text) {
  if (typeof text !== 'string' || !text.trim()) return text;
  if (/[.!?]$/.test(text.trim())) return text;   // a full sentence stays as written
  const words = text.split(/(\s+)/);
  const real = words.map((w, i) => (w.trim() ? i : -1)).filter((i) => i >= 0);
  const firstIdx = real[0];
  const lastIdx = real[real.length - 1];
  let afterBreak = false;
  return words.map((w, i) => {
    if (!w.trim()) return w;
    const out = fixWord(w, i === firstIdx || afterBreak, i === lastIdx);
    afterBreak = /[:—–]$/.test(w) || w === '—' || w === '–' || w === '/';
    return out;
  }).join('');
}

/** headingCase for a React child: only a plain string changes. */
export const headingChild = (child) => {
  if (typeof child === 'string') return headingCase(child);
  if (Array.isArray(child)) return child.map(headingChild);   // e.g. [<Icon/>, ' ', 'Section name']
  return child;
};
