// @vitest-environment jsdom

import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import {
  CommandMetricCard,
  CommandPageHero,
  isNumericMetricValue,
  metricValueText,
} from './CommandUI';

afterEach(cleanup);

describe('metric value helpers', () => {
  it('treats counts, rates, ratios, short units and the placeholder as numbers', () => {
    for (const value of [3, 0, '42', '1,234', '42%', '12.5k', '3 / 12', '12h', '☉ 1,200', '-', '—', null, undefined]) {
      expect(isNumericMetricValue(value), String(value)).toBe(true);
    }
  });

  it('treats words and dates as text', () => {
    for (const value of ['PENDING REVIEW', 'Not scheduled', 'Oct 21, 2026', 'Oct 25, 2026, 11:59 PM', 'LIVE', '2026-10-23']) {
      expect(isNumericMetricValue(value), value).toBe(false);
    }
  });

  it('sets stored capitals in sentence case and keeps acronyms', () => {
    expect(metricValueText('PENDING REVIEW')).toBe('Pending review');
    expect(metricValueText('WAITING FOR TRAINING')).toBe('Waiting for training');
    expect(metricValueText('OPEN')).toBe('Open');
    expect(metricValueText('RCON READY')).toBe('RCON ready');
    expect(metricValueText('AWAITING SAT')).toBe('Awaiting SAT');
    expect(metricValueText('N/A')).toBe('N/A');
  });

  it('leaves values that are already mixed case alone', () => {
    expect(metricValueText('Not scheduled')).toBe('Not scheduled');
    expect(metricValueText('Oct 21, 2026')).toBe('Oct 21, 2026');
  });
});

describe('CommandPageHero metrics', () => {
  it('skips empty and hidden metrics so no divider or cell is left behind', () => {
    render(
      <CommandPageHero
        title="Recruit status"
        metrics={[
          { label: 'Status', value: 'PENDING REVIEW' },
          false,
          { label: 'Secret', value: 4, hidden: true },
          { label: 'Billets', value: 3, className: 'hidden sm:block' },
        ]}
      />,
    );

    const terms = screen.getAllByRole('term').map((node) => node.textContent);
    expect(terms).toEqual(['Status', 'Billets']);
    // A width-dependent hide stays on the cell, which owns its own divider.
    const billets = screen.getByText('Billets').parentElement;
    expect(billets).toHaveClass('hidden', 'sm:block', 'border-l');
    expect(billets.parentElement).not.toHaveClass('divide-x');
  });

  it('sets words at body size in sentence case and keeps numbers large', () => {
    render(
      <CommandPageHero
        title="Recruit status"
        metrics={[
          { label: 'Status', value: 'PENDING REVIEW' },
          { label: 'Billets', value: 3 },
          { label: 'Operation', value: 'IRON ANVIL', preserveCase: true },
        ]}
      />,
    );

    const status = screen.getByText('Pending review');
    expect(status.tagName).toBe('DD');
    expect(status).not.toHaveClass('font-heading');
    expect(status).toHaveClass('text-[15px]');

    expect(screen.getByText('3')).toHaveClass('font-heading', 'text-2xl');
    expect(screen.getByText('IRON ANVIL')).toBeInTheDocument();
  });

  it('gives action buttons the app radius', () => {
    render(
      <CommandPageHero
        title="Training"
        actions={<button type="button" className="rounded-none">New course</button>}
      />,
    );
    expect(screen.getByRole('button', { name: 'New course' }).parentElement.className).toContain(
      '[&_:is(a,button).rounded-none]:rounded-md',
    );
  });
});

describe('CommandMetricCard', () => {
  it('sets a word value at body size in sentence case', () => {
    render(<CommandMetricCard label="Review state" value="PENDING REVIEW" />);
    const value = screen.getByText('Pending review');
    expect(value).not.toHaveClass('font-heading');
    expect(value).toHaveClass('text-[17px]');
  });

  it('keeps counts in the large condensed numerals and shows a placeholder for none', () => {
    const { rerender } = render(<CommandMetricCard label="Open" value={12} />);
    expect(screen.getByText('12')).toHaveClass('font-heading', 'text-[2rem]');
    rerender(<CommandMetricCard label="Open" value={null} />);
    expect(screen.getByText('-')).toHaveClass('font-heading');
  });
});
