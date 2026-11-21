// @vitest-environment jsdom

import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router';

import TabbedWorkspace, { edgeMask } from './TabbedWorkspace';

vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({ user: { role: 'admin' } }),
}));

// framer-motion animates in jsdom on real timers, so the panel wrapper is
// replaced by a plain div that records the entrance it was asked for.
let mockReducedMotion = false;
vi.mock('framer-motion', () => ({
  useReducedMotion: () => mockReducedMotion,
  motion: {
    // eslint-disable-next-line no-unused-vars
    div: ({ initial, animate, transition, ...props }) => (
      <div data-entrance={initial === false ? 'none' : 'fade'} {...props} />
    ),
  },
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  mockReducedMotion = false;
});

function LocationControls() {
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <>
      <output aria-label="Current query">{location.search}</output>
      <button type="button" onClick={() => navigate(-1)}>Back</button>
    </>
  );
}

const tabs = [
  { id: 'fleet', label: 'Fleet', element: <div>Fleet content</div> },
  { id: 'telemetry', label: 'Telemetry', element: <div>Telemetry content</div> },
];

describe('TabbedWorkspace URL state', () => {
  it('preserves unrelated query parameters and follows browser back navigation', async () => {
    render(
      <MemoryRouter initialEntries={['/workspace?tab=fleet&focus=active']}>
        <Routes>
          <Route
            path="/workspace"
            element={(
              <>
                <LocationControls />
                <TabbedWorkspace title="Server tools" tabs={tabs} />
              </>
            )}
          />
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.getByRole('tab', { name: 'Fleet' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByText('Session Active')).not.toBeInTheDocument();

    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Telemetry' }), { button: 0, ctrlKey: false });
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Telemetry' })).toHaveAttribute('aria-selected', 'true'));
    expect(screen.getByLabelText('Current query')).toHaveTextContent('focus=active');
    expect(screen.getByLabelText('Current query')).toHaveTextContent('tab=telemetry');

    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Fleet' })).toHaveAttribute('aria-selected', 'true'));
    expect(screen.getByText('Fleet content')).toBeInTheDocument();
  });
});

// jsdom has no layout, so the rail's geometry is described here: a 300px rail
// holding 100px tabs laid out left to right from the rail's current scroll.
function mockRailLayout({ railWidth = 300, tabWidth = 100 } = {}) {
  const scrollTo = vi.fn(function scrollTo({ left }) {
    this.scrollLeft = left;
  });
  const originals = {
    scrollTo: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollTo'),
    scrollWidth: Object.getOwnPropertyDescriptor(Element.prototype, 'scrollWidth'),
    clientWidth: Object.getOwnPropertyDescriptor(Element.prototype, 'clientWidth'),
  };
  const isRail = (el) => el.hasAttribute?.('data-tab-rail');
  const tabsIn = (el) => el.querySelectorAll('[role="tab"]').length;

  Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: scrollTo });
  Object.defineProperty(Element.prototype, 'scrollWidth', {
    configurable: true,
    get() { return isRail(this) ? tabsIn(this) * tabWidth : 0; },
  });
  Object.defineProperty(Element.prototype, 'clientWidth', {
    configurable: true,
    get() { return isRail(this) ? railWidth : 0; },
  });
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function rect() {
    if (isRail(this)) return { left: 0, right: railWidth, width: railWidth, top: 0, bottom: 44, height: 44 };
    if (this.getAttribute('role') === 'tab') {
      const rail = this.closest('[data-tab-rail]');
      const index = [...rail.querySelectorAll('[role="tab"]')].indexOf(this);
      const left = index * tabWidth - (rail.scrollLeft || 0);
      return { left, right: left + tabWidth, width: tabWidth, top: 0, bottom: 44, height: 44 };
    }
    return { left: 0, right: 0, width: 0, top: 0, bottom: 0, height: 0 };
  });

  return {
    scrollTo,
    restore() {
      for (const [key, descriptor] of Object.entries(originals)) {
        const target = key === 'scrollTo' ? HTMLElement.prototype : Element.prototype;
        if (descriptor) Object.defineProperty(target, key, descriptor);
        else delete target[key];
      }
    },
  };
}

const manyTabs = [
  'roster', 'recruitment', 'pipeline', 'awards', 'records', 'ranks',
  'alerts', 'identities', 'audit', 'backups', 'reports',
].map((id) => ({
  id,
  label: id[0].toUpperCase() + id.slice(1),
  description: `${id} description`,
  element: <div>{id} content</div>,
}));

function renderWorkspace(path, workspaceTabs = manyTabs) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/workspace" element={<TabbedWorkspace title="Personnel" tabs={workspaceTabs} />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('TabbedWorkspace tab rail on narrow screens', () => {
  let layout;
  afterEach(() => layout?.restore());

  it('centres a deep-linked tab in the rail instantly, without moving the page', () => {
    layout = mockRailLayout();
    const pageScroll = vi.spyOn(window, 'scrollTo').mockImplementation(() => {});

    renderWorkspace('/workspace?tab=audit');

    expect(screen.getByRole('tab', { name: 'Audit' })).toHaveAttribute('aria-selected', 'true');
    // Audit is the 9th tab: 800px in, centred in a 300px rail -> 700.
    expect(layout.scrollTo).toHaveBeenCalledWith({ left: 700, behavior: 'auto' });
    expect(pageScroll).not.toHaveBeenCalled();
  });

  it('fades only the edges that have tabs beyond them', () => {
    layout = mockRailLayout();
    renderWorkspace('/workspace?tab=roster');

    const rail = document.querySelector('[data-tab-rail]');
    expect(rail).toHaveAttribute('data-overflow', 'end');

    rail.scrollLeft = 400;
    fireEvent.scroll(rail);
    expect(rail).toHaveAttribute('data-overflow', 'start end');

    rail.scrollLeft = 900;
    fireEvent.scroll(rail);
    expect(rail).toHaveAttribute('data-overflow', 'start');
  });

  it('builds the fade mask for the overflowing edges only', () => {
    expect(edgeMask({ start: false, end: false })).toBeUndefined();
    const endOnly = edgeMask({ start: false, end: true }).maskImage;
    expect(endOnly).toContain('transparent 100%');
    expect(endOnly).not.toContain('transparent 0');
    const startOnly = edgeMask({ start: true, end: false });
    expect(startOnly.maskImage).toContain('transparent 0');
    expect(startOnly.maskImage).not.toContain('transparent 100%');
    expect(startOnly.WebkitMaskImage).toBe(startOnly.maskImage);
  });

  it('draws no fade when every tab fits', () => {
    layout = mockRailLayout({ railWidth: 2000 });
    renderWorkspace('/workspace?tab=roster');

    const rail = document.querySelector('[data-tab-rail]');
    expect(rail).not.toHaveAttribute('data-overflow');
  });

  it('writes the active tab description under the rail and follows tab changes', async () => {
    layout = mockRailLayout();
    renderWorkspace('/workspace?tab=roster');

    expect(screen.getByTestId('tab-description')).toHaveTextContent('roster description');

    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Backups' }), { button: 0, ctrlKey: false });
    await waitFor(() => expect(screen.getByTestId('tab-description')).toHaveTextContent('backups description'));
    // A later change glides; the first positioning did not.
    expect(layout.scrollTo).toHaveBeenLastCalledWith({ left: 800, behavior: 'smooth' });
  });

  it('keeps arrow-key tab navigation', async () => {
    layout = mockRailLayout();
    renderWorkspace('/workspace?tab=roster');

    const roster = screen.getByRole('tab', { name: 'Roster' });
    roster.focus();
    fireEvent.keyDown(roster, { key: 'ArrowRight' });

    const recruitment = screen.getByRole('tab', { name: 'Recruitment' });
    await waitFor(() => expect(recruitment).toHaveAttribute('aria-selected', 'true'));
    expect(recruitment).toHaveFocus();
    expect(screen.getByText('recruitment content')).toBeInTheDocument();
  });
});

describe('TabbedWorkspace transitions', () => {
  const entranceOf = (text) => screen.getByText(text).parentElement.getAttribute('data-entrance');

  it('does not animate the tab shown on arrival, only later switches', async () => {
    renderWorkspace('/workspace?tab=fleet', tabs);

    // The route fade belongs to CommandShell; the first tab must not add one.
    expect(entranceOf('Fleet content')).toBe('none');

    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Telemetry' }), { button: 0, ctrlKey: false });
    await waitFor(() => expect(screen.getByText('Telemetry content')).toBeInTheDocument());
    expect(entranceOf('Telemetry content')).toBe('fade');
  });

  it('switches tabs without a fade under reduced motion', async () => {
    mockReducedMotion = true;
    renderWorkspace('/workspace?tab=fleet', tabs);

    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Telemetry' }), { button: 0, ctrlKey: false });
    await waitFor(() => expect(screen.getByText('Telemetry content')).toBeInTheDocument());
    expect(entranceOf('Telemetry content')).toBe('none');
  });
});
