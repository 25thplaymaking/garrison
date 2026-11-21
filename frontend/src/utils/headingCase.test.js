import { expect, test } from 'vitest';
import { headingCase, headingChild } from './headingCase';

test.each([
  ['Command center', 'Command Center'],
  ['Company structure and callsigns', 'Company Structure and Callsigns'],
  ['Servers the panel runs', 'Servers the Panel Runs'],
  ['Who can skip the queue, and where', 'Who Can Skip the Queue, and Where'],
  ['Date-time group (Zulu)', 'Date-Time Group (Zulu)'],
  ['RCON and SAT setup', 'RCON and SAT Setup'],
  ['What happens next', 'What Happens Next'],
  ['Docs at example.com', 'Docs at example.com'],
  ['Profile changes', 'Profile Changes'],
  ['Server status: what is up', 'Server Status: What Is Up'],
  ['Pick one to', 'Pick One To'],
  ['Mods & Presets — pull from Workshop', 'Mods & Presets — Pull from Workshop'],
  ['Build the mission on a canvas.', 'Build the mission on a canvas.'],
])('%s -> %s', (input, expected) => {
  expect(headingCase(input)).toBe(expected);
});

test('only plain strings change', () => {
  const node = { type: 'span' };
  expect(headingChild(node)).toBe(node);
  expect(headingChild('unit roster')).toBe('Unit Roster');
  expect(headingCase('')).toBe('');
});
