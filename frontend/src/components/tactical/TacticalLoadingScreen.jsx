import React from 'react';
import { cn } from '@/lib/utils';
import { GarrisonMark } from '@/components/brand/GarrisonMark';

const MODE_CLASSES = {
  fullscreen: 'min-h-screen min-h-[100svh] px-5 py-8 sm:px-8',
  surface: 'min-h-[min(62vh,38rem)] px-4 py-10 sm:px-8',
  panel: 'min-h-32 p-5 sm:p-6',
};

/**
 * The loading surface shared by route, sign-in, workspace and data-loading
 * boundaries: the mark, one plain line saying what is happening, and a small
 * spinner. `detail`, `eyebrow` and `code` are accepted for older call sites
 * and not shown.
 */
// eslint-disable-next-line no-unused-vars
export default function TacticalLoadingScreen({
  as: Root = 'div',
  mode = 'surface',
  label = 'Loading…',
  detail,
  eyebrow,
  code,
  rows = 0,
  className = '',
}) {
  const skeletonRows = Math.min(Math.max(Number(rows) || 0, 0), 8);
  const panel = mode === 'panel';

  return (
    <Root
      className={cn(
        'relative flex w-full items-center justify-center bg-mil-bg-deep text-mil-fg',
        MODE_CLASSES[mode] || MODE_CLASSES.surface,
        className,
      )}
      aria-busy="true"
      data-testid="loading-screen"
    >
      <div className={cn('w-full', panel ? 'max-w-none' : 'max-w-sm')}>
        <div className={cn('flex items-center', panel ? 'gap-4' : 'flex-col text-center')}>
          <GarrisonMark size={panel ? 40 : 64} title="" />
          <div className={cn('flex min-w-0 items-center gap-3', panel ? '' : 'mt-6')} role="status" aria-live="polite" aria-atomic="true">
            <span
              className="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-brand-light border-t-transparent motion-reduce:animate-none"
              aria-hidden="true"
            />
            <p className="text-[15px] leading-6 text-mil-soft">{label}</p>
          </div>
        </div>

        {skeletonRows > 0 && (
          <div className="mt-5 space-y-2" aria-hidden="true" data-testid="tactical-loading-rows">
            {Array.from({ length: skeletonRows }).map((_, index) => (
              <div key={index} data-testid="tactical-loading-row" className="h-10 animate-pulse rounded-md bg-mil-bg-elevated/60 motion-reduce:animate-none" />
            ))}
          </div>
        )}
      </div>
    </Root>
  );
}
