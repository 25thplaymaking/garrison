import React, { Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { useSearchParams, useLocation } from 'react-router';
import { useAuth } from '@/context/AuthContext';
import TacticalLoadingScreen from '@/components/tactical/TacticalLoadingScreen';
import { headingChild } from '@/utils/headingCase';

const DEFAULT_FALLBACK = (
  <TacticalLoadingScreen
    mode="surface"
    label="Loading"
    detail="Fetching this section"
  />
);

// Active-state tone classes for tab triggers — tied to the C2 palette.
// All variants share the same hover styling on the inactive state.
// Keyed on aria-selected, not data-state: when a tab has a description, the
// Radix TooltipTrigger (asChild) overwrites the trigger's data-state with the
// tooltip's own open/closed state, so data-[state=active] never matched.
// Active tab: bright label with an underline in the tab's tone. Gold is the
// default; a tab can ask for another tone when it marks something different
// (red for an incident queue, for instance).
const TONE_CLASSES = {
  gold:   'aria-selected:after:bg-brand',
  red:    'aria-selected:after:bg-red-400',
  amber:  'aria-selected:after:bg-amber-400',
  blue:   'aria-selected:after:bg-sky-400',
  green:  'aria-selected:after:bg-emerald-400',
  purple: 'aria-selected:after:bg-purple-400',
  slate:  'aria-selected:after:bg-mil-soft',
};

const TRIGGER_BASE =
  'group relative min-h-11 shrink-0 rounded-md border-0 bg-transparent px-3 py-2 ' +
  'text-sm font-medium text-mil-muted shadow-none transition-colors duration-150 ' +
  'hover:bg-mil-bg-elevated/60 hover:text-mil-bright ' +
  'focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-brand/50 ' +
  'aria-selected:bg-transparent aria-selected:text-mil-bright aria-selected:shadow-none data-[state=active]:bg-transparent data-[state=active]:shadow-none ' +
  'after:absolute after:inset-x-2 after:-bottom-[5px] after:h-0.5 after:rounded-full after:bg-transparent';

// Width of the fade drawn on an edge of the tab rail that has more tabs past it.
const EDGE_FADE_PX = 36;

export function edgeMask({ start, end }) {
  if (!start && !end) return undefined;
  const from = start ? `transparent 0, #000 ${EDGE_FADE_PX}px` : '#000 0';
  const to = end ? `#000 calc(100% - ${EDGE_FADE_PX}px), transparent 100%` : '#000 100%';
  const image = `linear-gradient(to right, ${from}, ${to})`;
  return { maskImage: image, WebkitMaskImage: image };
}

/**
 * Tracks whether the rail can scroll further left (`start`) or right (`end`).
 * The rail only overflows on narrow screens, so on desktop both stay false and
 * no mask is applied.
 */
function useRailOverflow(railRef, deps) {
  const [overflow, setOverflow] = useState({ start: false, end: false });

  const measure = useCallback(() => {
    const rail = railRef.current;
    if (!rail) return;
    const max = rail.scrollWidth - rail.clientWidth;
    // One pixel of slack: fractional widths leave scrollLeft a hair short of max.
    const next = { start: rail.scrollLeft > 1, end: max - rail.scrollLeft > 1 };
    setOverflow((prev) => (prev.start === next.start && prev.end === next.end ? prev : next));
  }, [railRef]);

  useLayoutEffect(() => {
    measure();
    const rail = railRef.current;
    if (!rail) return undefined;
    rail.addEventListener('scroll', measure, { passive: true });
    let observer;
    if (typeof ResizeObserver === 'function') {
      observer = new ResizeObserver(measure);
      observer.observe(rail);
      if (rail.firstElementChild) observer.observe(rail.firstElementChild);
    } else {
      window.addEventListener('resize', measure);
    }
    return () => {
      rail.removeEventListener('scroll', measure);
      if (observer) observer.disconnect();
      else window.removeEventListener('resize', measure);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [measure, ...deps]);

  return overflow;
}

/**
 * Centres the active tab in the rail. Only the rail scrolls: element
 * `scrollIntoView({ inline: 'center', block: 'nearest' })` would also move the
 * page when the rail sits outside the viewport (a restored scroll position),
 * which a deep link must never do. The first positioning is instant; later
 * changes glide unless the viewer asked for reduced motion.
 */
function useCenterActiveTab(railRef, activeTab, tabCount, reducedMotion) {
  const positioned = useRef(false);

  useLayoutEffect(() => {
    const rail = railRef.current;
    if (!rail || !activeTab) return;
    const active = rail.querySelector('[role="tab"][aria-selected="true"]');
    if (!active) return;

    const railBox = rail.getBoundingClientRect();
    const tabBox = active.getBoundingClientRect();
    const max = rail.scrollWidth - rail.clientWidth;
    const centred = rail.scrollLeft + (tabBox.left - railBox.left) - (railBox.width - tabBox.width) / 2;
    const left = Math.max(0, Math.min(max, Math.round(centred)));

    const behavior = positioned.current && !reducedMotion ? 'smooth' : 'auto';
    positioned.current = true;
    if (max <= 0 || Math.abs(left - rail.scrollLeft) < 1) return;
    if (typeof rail.scrollTo === 'function') rail.scrollTo({ left, behavior });
    else rail.scrollLeft = left;
  }, [railRef, activeTab, tabCount, reducedMotion]);
}

export default function TabbedWorkspace({
  title,
  description,
  tabs,
  defaultTabId,
  fallback = DEFAULT_FALLBACK,
  eyebrow,
  // Inset for the title and tab rail. The admin shell pads its content; the
  // member shell leaves padding to each page, so member hubs pass one here
  // that lines up with their tab pages.
  headerClassName = '',
}) {
  const { user } = useAuth();
  const role = user?.role;
  const [searchParams, setSearchParams] = useSearchParams();
  const location = useLocation();
  const reducedMotion = useReducedMotion();
  const railRef = useRef(null);

  const visibleTabs = useMemo(
    () => tabs.filter((t) => (typeof t.show === 'function' ? t.show(role) : true)),
    [tabs, role],
  );

  const initialTab = useMemo(() => {
    const fromQuery = searchParams.get('tab');
    if (fromQuery && visibleTabs.some((t) => t.id === fromQuery)) return fromQuery;
    // A tab can answer to an old id (e.g. a tab that was folded into another).
    const aliased = fromQuery && visibleTabs.find((t) => (t.aliases || []).includes(fromQuery));
    if (aliased) return aliased.id;
    const matched = visibleTabs.find((t) =>
      (t.legacyPaths || []).some((p) => location.pathname.includes(p)),
    );
    if (matched) return matched.id;
    if (defaultTabId && visibleTabs.some((t) => t.id === defaultTabId)) return defaultTabId;
    return visibleTabs[0]?.id;
  }, [searchParams, location.pathname, visibleTabs, defaultTabId]);

  const [tab, setTab] = useState(initialTab);

  // Query state is authoritative so browser back/forward and legacy-path
  // redirects always select the workspace represented by the URL.
  useEffect(() => {
    setTab(initialTab);
  }, [initialTab]);

  // Transitions: CommandShell fades the content on a route (pathname) change,
  // and a tab switch only changes `?tab=`, which the shell does not key on. So
  // the workspace animates tab switches itself, and only those: the tab shown
  // when the workspace mounts arrives with the shell's fade, not a second one.
  const [mountedTab] = useState(tab);
  const [switched, setSwitched] = useState(false);
  if (!switched && tab !== mountedTab) setSwitched(true);
  const animateTab = switched && !reducedMotion;

  const overflow = useRailOverflow(railRef, [visibleTabs.length]);
  useCenterActiveTab(railRef, tab, visibleTabs.length, reducedMotion);

  const handleTabChange = (value) => {
    setTab(value);
    const nextParams = new URLSearchParams(searchParams);
    nextParams.set('tab', value);
    setSearchParams(nextParams);
  };

  if (!visibleTabs.length) {
    return (
      <div className="space-y-4">
        <Header title={title} description={description} eyebrow={eyebrow} />
        <div className="rounded-lg border border-dashed border-mil-line-strong p-6 text-sm text-mil-muted">
          You do not have access to any section in this area.
        </div>
      </div>
    );
  }

  const activeTab = visibleTabs.find((t) => t.id === tab);
  const overflowState = [overflow.start && 'start', overflow.end && 'end'].filter(Boolean).join(' ');

  return (
    <TooltipProvider delayDuration={120}>
      <Tabs value={tab} onValueChange={handleTabChange} className="relative w-full">
        <div className={`space-y-4 ${headerClassName}`}>
          <Header title={title} description={description} eyebrow={eyebrow} />
          <div>
            {/* Underlined tab rail: scrolls sideways on narrow screens rather
                than wrapping into a block of buttons. The edge with more tabs
                past it fades out, so a phone shows that the rail continues.
                The hairline sits on the wrapper so the fade never thins it. */}
            <div className="-mx-1 border-b border-mil-line">
              <div
                ref={railRef}
                data-tab-rail=""
                data-overflow={overflowState || undefined}
                className="overflow-x-auto px-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
                style={edgeMask(overflow)}
              >
                <TabsList className="h-auto w-max min-w-full justify-start gap-0.5 rounded-none border-0 bg-transparent p-0 pb-1">
                  {visibleTabs.map((t) => {
                    const Icon = t.icon;
                    const toneClass = TONE_CLASSES[t.tone] || TONE_CLASSES.gold;
                    const trigger = (
                      <TabsTrigger value={t.id} className={`${TRIGGER_BASE} ${toneClass}`}>
                        {Icon && (
                          <Icon className="mr-1.5 h-4 w-4 text-mil-dim group-aria-selected:text-brand" aria-hidden="true" />
                        )}
                        <span className="truncate">{headingChild(t.label)}</span>
                      </TabsTrigger>
                    );
                    return t.description ? (
                      <Tooltip key={t.id}>
                        <TooltipTrigger asChild>{trigger}</TooltipTrigger>
                        <TooltipContent
                          side="top"
                          className="max-w-xs rounded-md border border-mil-line bg-mil-bg-panel text-left text-[13px] leading-5 text-mil-fg"
                        >
                          {t.description}
                        </TooltipContent>
                      </Tooltip>
                    ) : (
                      <React.Fragment key={t.id}>{trigger}</React.Fragment>
                    );
                  })}
                </TabsList>
              </div>
            </div>
            {/* Descriptions are hover tooltips, which touch screens never show.
                Below md, and on any screen without a fine pointer, the active
                tab's description is written out under the rail instead. */}
            {activeTab?.description && (
              <p
                data-testid="tab-description"
                className="mt-2 max-w-3xl text-[13px] leading-5 text-mil-muted md:pointer-fine:hidden"
              >
                {activeTab.description}
              </p>
            )}
          </div>
        </div>

        {visibleTabs.map((t) => {
          const Component = t.Component;
          const contentClass = t.fullBleed
            ? 'mt-4 -mx-4 sm:-mx-6 *:min-h-[calc(100vh-12rem)]'
            : 'mt-4';
          return (
            <TabsContent key={t.id} value={t.id} className={contentClass}>
              {/* Opacity only: a transform would make this wrapper the
                  containing block for fixed-position dialogs in the tab. */}
              <motion.div
                className={t.fullBleed ? 'min-w-0 *:min-h-[calc(100vh-12rem)]' : 'min-w-0'}
                initial={animateTab ? { opacity: 0 } : false}
                animate={{ opacity: 1 }}
                transition={{ duration: 0.16, ease: 'easeOut' }}
              >
                <Suspense fallback={t.ownsLoadingSequence ? null : fallback}>
                  {t.element ? t.element : Component ? <Component /> : null}
                </Suspense>
              </motion.div>
            </TabsContent>
          );
        })}
      </Tabs>
    </TooltipProvider>
  );
}

function Header({ title, description, eyebrow }) {
  if (!title && !description && !eyebrow) return null;
  return (
    <div className="pt-1">
      {eyebrow && <p className="text-[13px] font-medium text-brand">{eyebrow}</p>}
      {title && (
        <h1 className="mt-1 break-words font-heading text-[2rem] font-semibold leading-[1.05] text-mil-bright sm:text-[2.5rem]">
          {headingChild(title)}
        </h1>
      )}
      {description && <p className="mt-2 max-w-3xl text-[15px] leading-6 text-mil-muted">{description}</p>}
    </div>
  );
}
