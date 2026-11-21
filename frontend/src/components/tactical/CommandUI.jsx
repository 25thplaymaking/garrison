import React, { useEffect, useState } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { AlertTriangle, Loader2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { DialogContent } from '@/components/ui/dialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { cn } from '@/lib/utils';
import { titleCase } from '@/utils/titleCase';
import TacticalLoadingScreen from '@/components/tactical/TacticalLoadingScreen';
import { headingChild } from '@/utils/headingCase';

export const commandFonts = {
  mono: { fontFamily: 'var(--font-mono)' },
  condensed: { fontFamily: 'var(--font-condensed)' },
  display: { fontFamily: 'var(--font-heading)' },
};

// Centralized badge tone registry. The threat-map popups (EventPopup,
// OperationPopup, IntelPopup) each used to derive their own threat /
// credibility / classification color sets, which drifted apart over time —
// "high" was orange in one popup and amber in another. New surfaces should
// import from here so all C2 surfaces speak the same color vocabulary.
//
// Each entry is a single `className` string ready to drop onto a `<Badge>` or
// `<span>`; that lets consumers compose with their own positioning classes
// without us re-exporting a custom component. `default` is the fallback for
// unknown values so callers never produce an unstyled badge.
export const BADGE_TONES = {
  threat: {
    critical: 'border-red-500/45 bg-red-500/15 text-red-300',
    high:     'border-orange-500/45 bg-orange-500/12 text-orange-300',
    medium:   'border-amber-500/45 bg-amber-500/12 text-amber-300',
    low:      'border-[rgba(232,131,58,0.4)] bg-[rgba(232,131,58,0.12)] text-brand',
    info:     'border-sky-500/40 bg-sky-500/10 text-sky-300',
    default:  'border-[rgba(125,125,125,0.45)] bg-mil-bg-elevated text-mil-muted',
  },
  credibility: {
    confirmed:    'border-emerald-500/45 bg-emerald-500/10 text-emerald-300',
    probable:     'border-[rgba(232,131,58,0.4)] bg-[rgba(232,131,58,0.12)] text-brand',
    possible:     'border-amber-500/45 bg-amber-500/12 text-amber-300',
    doubtful:     'border-orange-500/45 bg-orange-500/12 text-orange-300',
    improbable:   'border-red-500/45 bg-red-500/15 text-red-300',
    unconfirmed:  'border-[rgba(125,125,125,0.45)] bg-mil-bg-elevated text-mil-muted',
    default:      'border-[rgba(125,125,125,0.45)] bg-mil-bg-elevated text-mil-muted',
  },
  classification: {
    unclassified: 'border-[rgba(125,125,125,0.45)] bg-mil-bg-elevated text-mil-muted',
    sensitive:    'border-[rgba(232,131,58,0.4)] bg-[rgba(232,131,58,0.12)] text-brand',
    confidential: 'border-amber-500/45 bg-amber-500/12 text-amber-300',
    secret:       'border-orange-500/45 bg-orange-500/12 text-orange-300',
    'top-secret': 'border-red-500/45 bg-red-500/15 text-red-300',
    default:      'border-[rgba(125,125,125,0.45)] bg-mil-bg-elevated text-mil-muted',
  },
  severity: {
    critical: 'border-red-500/45 bg-red-500/15 text-red-300',
    error:    'border-red-500/40 bg-red-500/10 text-red-300',
    warning:  'border-amber-500/45 bg-amber-500/12 text-amber-300',
    info:     'border-sky-500/40 bg-sky-500/10 text-sky-300',
    debug:    'border-[rgba(125,125,125,0.45)] bg-mil-bg-elevated text-mil-muted',
    default:  'border-[rgba(125,125,125,0.45)] bg-mil-bg-elevated text-mil-muted',
  },
};

/** Lookup a badge className by category + value. Lowercases the value so
 *  callers can pass either "HIGH" or "high". Falls back to the registry's
 *  `default` entry rather than returning an empty string so a badge never
 *  renders unstyled. */
export function getBadgeToneClass(category, value) {
  const set = BADGE_TONES[category];
  if (!set) return BADGE_TONES.threat.default;
  const key = String(value || '').toLowerCase();
  return set[key] || set.default;
}

// ── Status tone registry ────────────────────────────────────────────────────
// Server, incident and notification statuses each had their own
// per-page color map (STATUS_COLORS in UsersManager, LOARequest, PipelineMgr,
// OperationDetail, IntelBoard, etc.) and they drifted over time — "approved"
// was emerald in one place, green-500 in another, brand in a third.
// STATUS_TONES gives every surface one vocabulary; `lifecycle` is the most
// reusable scale, others are domain-specific.
export const STATUS_TONES = {
  lifecycle: {
    pending:    'border-brand-light/30 bg-brand-light/10 text-brand-light',
    approved:   'border-emerald-500/30 bg-emerald-500/10 text-emerald-300',
    denied:     'border-red-500/30 bg-red-500/10 text-red-300',
    cancelled:  'border-[rgba(125,125,125,0.45)] bg-mil-bg-elevated text-mil-muted',
    completed:  'border-emerald-500/30 bg-emerald-500/10 text-emerald-300',
    active:     'border-emerald-500/30 bg-emerald-500/10 text-emerald-300',
    inactive:   'border-[rgba(125,125,125,0.45)] bg-mil-bg-elevated text-mil-muted',
    archived:   'border-[rgba(125,125,125,0.45)] bg-mil-bg-elevated text-mil-muted',
    draft:      'border-sky-500/30 bg-sky-500/10 text-sky-300',
    planning:   'border-sky-500/30 bg-sky-500/10 text-sky-300',
    expired:    'border-[rgba(125,125,125,0.45)] bg-mil-bg-elevated text-mil-muted',
    open:       'border-brand-light/30 bg-brand-light/10 text-brand-light',
    passed:     'border-emerald-500/30 bg-emerald-500/10 text-emerald-300',
    failed:     'border-red-500/30 bg-red-500/10 text-red-300',
    success:    'border-emerald-500/30 bg-emerald-500/10 text-emerald-300',
    partial:    'border-amber-500/40 bg-amber-500/12 text-amber-300',
    failure:    'border-red-500/30 bg-red-500/10 text-red-300',
    default:    'border-[rgba(125,125,125,0.45)] bg-mil-bg-elevated text-mil-muted',
  },
  rsvp: {
    attending:  'border-emerald-500/30 bg-emerald-500/10 text-emerald-300',
    tentative:  'border-sky-500/30 bg-sky-500/10 text-sky-300',
    waitlisted: 'border-orange-500/40 bg-orange-500/12 text-orange-300',
    declined:   'border-red-500/30 bg-red-500/10 text-red-300',
    default:    'border-[rgba(125,125,125,0.45)] bg-mil-bg-elevated text-mil-muted',
  },
  personnel: {
    recruit:  'bg-brand-dark text-mil-bg-deep',
    active:   'bg-emerald-700 text-emerald-50',
    reserve:  'bg-brand/60 text-mil-bg-deep',
    staff:    'bg-sky-700 text-sky-50',
    command:  'bg-brand text-mil-bg-deep',
    loa:      'bg-blue-800 text-blue-50',
    inactive: 'bg-mil-bg-elevated text-mil-muted',
    default:  'bg-mil-bg-elevated text-mil-muted',
  },
};

/** Lookup a status className by category + value. Same fallback semantics
 *  as `getBadgeToneClass`. */
export function getStatusToneClass(category, value) {
  const set = STATUS_TONES[category];
  if (!set) return STATUS_TONES.lifecycle.default;
  const key = String(value || '').toLowerCase();
  return set[key] || set.default;
}

export function CommandMotion({ children, className = '', delay = 0, as = motion.div, ...props }) {
  const Component = as;
  const reducedMotion = useReducedMotion();
  return (
    <Component
      {...props}
      initial={reducedMotion ? false : { opacity: 0, y: 14 }}
      animate={reducedMotion ? undefined : { opacity: 1, y: 0 }}
      transition={{ duration: 0.3, delay, ease: [0.25, 0.46, 0.45, 0.94] }}
      className={className}
    >
      {children}
    </Component>
  );
}

// ── Metric values ───────────────────────────────────────────────────────────
// Stat numerals are set large in the condensed face. Words and dates are not
// numerals: at 24-32px condensed capitals "PENDING REVIEW" or "Oct 25, 2026,
// 11:59 PM" wrap a tile into three lines. Those are set at body size instead.
// A currency mark may lead ("$1,200") or trail ("1,234 ☉").
const NUMERIC_METRIC = /^[+\-−]?\s*[$€£☉]?\s*\d[\d.,\s]*(?:%|[kmb]|[smhdw]|\s*\/\s*\d[\d.,]*)?(?:\s*[$€£☉])?$/i;
const PLACEHOLDER_METRIC = /^[-–—]$/;

/** True when a metric value reads as a number (a count, a percentage, a
 *  ratio, a short unit such as "12h", or the "-" placeholder). A node the
 *  caller composed is left as designed. */
export function isNumericMetricValue(value) {
  if (value === null || value === undefined || typeof value === 'number' || typeof value === 'bigint') return true;
  if (typeof value !== 'string') return true;
  const text = value.trim();
  return !text || PLACEHOLDER_METRIC.test(text) || NUMERIC_METRIC.test(text);
}

/** Status labels often arrive in stored capitals ("PENDING REVIEW"). An
 *  all-caps word value is set in sentence case ("Pending review"); unit
 *  acronyms (titleCase's list: BCT, LOA, S-1…) and words with digits keep
 *  their capitals, and a value with any lower case is left as written. */
export function metricValueText(value) {
  if (typeof value !== 'string' || /[a-z]/.test(value) || !/[A-Z]{2}/.test(value)) return value;
  let first = true;
  return value
    .trim()
    .split(/(\s+)/)
    .map((word) => {
      if (!word.trim()) return word;
      const keep = /\d/.test(word) || titleCase(word) === word;
      const out = keep ? word : word.toLowerCase();
      const cased = first && !keep ? out.charAt(0).toUpperCase() + out.slice(1) : out;
      first = false;
      return cased;
    })
    .join('');
}

function MetricValue({ value, preserveCase, numericClassName, textClassName, className }) {
  const numeric = isNumericMetricValue(value);
  return (
    <dd className={cn(numeric ? numericClassName : textClassName, className)}>
      {numeric || preserveCase ? value : metricValueText(value)}
    </dd>
  );
}

/**
 * Page masthead. `metrics` is a list of `{ label, value, className?,
 * preserveCase?, hidden? }`: falsy entries and `hidden: true` are skipped, and
 * a `className` that hides a cell at some widths (`hidden sm:block`) takes the
 * cell's divider with it. Set `preserveCase` on a value that must keep its
 * capitals, such as an operation name.
 */
export function CommandPageHero({ eyebrow, title, description, icon: Icon, actions, metrics = [] }) {
  const shownMetrics = (metrics || []).filter((metric) => metric && !metric.hidden);
  return (
    <CommandMotion className="relative border-b border-mil-line pb-6 pt-1">
      <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
        <div className="min-w-0 max-w-3xl">
          {(eyebrow || Icon) && (
            <p className="flex items-center gap-2 text-[13px] font-medium text-brand">
              {Icon && <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />}
              {eyebrow && <span className="truncate">{eyebrow}</span>}
            </p>
          )}
          <h1 className="mt-2 font-heading text-[2rem] font-semibold leading-[1.05] text-mil-bright sm:text-[2.5rem]">
            {headingChild(title)}
          </h1>
          {description && <p className="mt-3 max-w-2xl text-[15px] leading-6 text-mil-muted">{description}</p>}
        </div>
        {(actions || shownMetrics.length > 0) && (
          <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end lg:justify-end">
            {shownMetrics.length > 0 && (
              // Each cell draws its own left and top hairline, pulled 1px under
              // its neighbour; the strip clips the ones on its outer edge. So a
              // cell hidden at this width removes its divider too, a wrapped
              // row gets a rule above it, and cells grow to fill a phone-width
              // strip instead of leaving an empty cell beside them.
              <dl className="flex flex-wrap overflow-hidden rounded-lg border border-mil-line bg-mil-bg-card">
                {shownMetrics.map((metric) => (
                  <div
                    key={metric.label}
                    className={cn('-ml-px -mt-px min-w-[96px] flex-auto border-l border-t border-mil-line px-4 py-2.5', metric.className)}
                  >
                    <dt className="text-xs text-mil-muted">{metric.label}</dt>
                    <MetricValue
                      value={metric.value}
                      preserveCase={metric.preserveCase}
                      numericClassName="mt-0.5 font-heading text-2xl font-semibold leading-none text-mil-bright tabular-nums"
                      textClassName="mt-0.5 text-[15px] font-semibold leading-6 text-mil-bright"
                    />
                  </div>
                ))}
              </dl>
            )}
            {/* Pages still pass `rounded-none` on action buttons from before
                the overhaul; in the masthead they take the app's radius. */}
            {actions && <div className="contents [&_:is(a,button).rounded-none]:rounded-md">{actions}</div>}
          </div>
        )}
      </div>
    </CommandMotion>
  );
}

export function CommandMetricCard({ icon: Icon, label, value, detail, tone = 'gold', preserveCase = false }) {
  const tones = {
    gold: { icon: 'text-brand', value: 'text-mil-bright' },
    green: { icon: 'text-emerald-400', value: 'text-emerald-300' },
    blue: { icon: 'text-sky-400', value: 'text-sky-200' },
    red: { icon: 'text-red-400', value: 'text-red-300' },
    muted: { icon: 'text-mil-dim', value: 'text-mil-soft' },
  };
  const t = tones[tone] || tones.gold;
  return (
    <div className="rounded-lg border border-mil-line bg-mil-bg-card p-4 transition-colors hover:border-mil-line-strong">
      <div className="flex items-start justify-between gap-3">
        <span className="text-[13px] font-medium text-mil-muted">{label}</span>
        {Icon && <Icon className={cn('h-4 w-4 shrink-0', t.icon)} aria-hidden="true" />}
      </div>
      {isNumericMetricValue(value) ? (
        <div className={cn('mt-2 font-heading text-[2rem] font-semibold leading-none tabular-nums', t.value)}>{value ?? '-'}</div>
      ) : (
        <div className={cn('mt-2 text-[17px] font-semibold leading-6', t.value)}>{preserveCase ? value : metricValueText(value)}</div>
      )}
      {detail && <p className="mt-1.5 text-xs leading-5 text-mil-muted">{detail}</p>}
    </div>
  );
}

export function CommandPanel({ children, className = '', ...props }) {
  return (
    <CommandMotion {...props} className={cn('rounded-lg border border-mil-line bg-mil-bg-card', className)}>
      {children}
    </CommandMotion>
  );
}

export function SectionHeader({ eyebrow, title, icon: Icon, action }) {
  return (
    <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        <h2 className="flex items-center gap-2 font-heading text-xl font-semibold leading-tight text-mil-bright sm:text-[1.375rem]">
          {Icon && <Icon className="h-[18px] w-[18px] shrink-0 text-brand" aria-hidden="true" />}
          <span className="min-w-0">{headingChild(title)}</span>
        </h2>
        {eyebrow && <p className="mt-0.5 text-[13px] text-mil-muted">{eyebrow}</p>}
      </div>
      {action}
    </div>
  );
}

export function CommandLoadingState({ label = 'Loading module', rows = 4, immersive = true }) {
  if (!immersive) {
    return (
      <div className="rounded-lg border border-mil-line bg-mil-bg-card p-6" aria-busy="true">
        <div className="mb-5 flex items-center gap-3 text-mil-soft" role="status" aria-live="polite">
          <Loader2 className="h-5 w-5 animate-spin text-brand motion-reduce:animate-none" aria-hidden="true" />
          <span className="text-sm">{label}</span>
        </div>
        <div className="space-y-2" aria-hidden="true">
          {Array.from({ length: Math.min(Math.max(Number(rows) || 0, 0), 8) }).map((_, index) => (
            <div key={index} className="h-12 animate-pulse rounded-md bg-mil-bg-elevated/60 motion-reduce:animate-none" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <TacticalLoadingScreen
      mode="panel"
      label={label}
      detail="Synchronizing operational data"
      code="MODULE // RECEIVING"
      rows={rows}
    />
  );
}

export function CommandEmptyState({ icon: Icon = AlertTriangle, title, description, action }) {
  return (
    <div className="rounded-lg border border-dashed border-mil-line-strong px-6 py-10 text-center">
      <Icon className="mx-auto h-8 w-8 text-mil-dim" aria-hidden="true" />
      <h3 className="mt-3 font-body text-base font-semibold text-mil-fg">{title}</h3>
      {description && <p className="mx-auto mt-1.5 max-w-xl text-sm leading-6 text-mil-muted">{description}</p>}
      {action && <div className="mt-5 flex justify-center">{action}</div>}
    </div>
  );
}

export function CommandDialogContent({ className = '', children, ...props }) {
  return (
    <DialogContent
      className={cn(
        'w-[calc(100vw-1rem)] max-w-2xl max-h-[calc(100dvh-2rem)] overflow-hidden border-mil-line bg-mil-bg-panel p-0 text-mil-fg',
        className,
      )}
      {...props}
    >
      {children}
    </DialogContent>
  );
}

export function CommandDialogBody({ children, className = '' }) {
  return <div className={cn('max-h-[calc(100dvh-9rem)] overflow-y-auto px-5 py-5 sm:px-6', className)}>{children}</div>;
}

export function CommandDialogFooter({ children, className = '' }) {
  return (
    <div className={cn('sticky bottom-0 flex flex-col-reverse gap-2 border-t border-mil-line bg-mil-bg-panel/96 px-5 py-4 sm:flex-row sm:justify-end sm:px-6', className)}>
      {children}
    </div>
  );
}

export function ConfirmActionDialog({
  open,
  onOpenChange,
  title = 'Confirm action',
  description,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  onConfirm,
  destructive = false,
  busy = false,
  confirmPhrase,
}) {
  const [internalBusy, setInternalBusy] = useState(false);
  const [typed, setTyped] = useState('');
  const isBusy = busy || internalBusy;
  // Bulk-destructive actions can require typing a phrase (e.g. CLEAR) first.
  const phraseMissing = Boolean(confirmPhrase) && typed.trim() !== confirmPhrase;

  useEffect(() => {
    if (!open) {
      setInternalBusy(false);
      setTyped('');
    }
  }, [open]);
  // A replacement prompt (another confirm while this one is open) starts empty.
  useEffect(() => { setTyped(''); }, [confirmPhrase, title]);

  const handleConfirm = async () => {
    try {
      setInternalBusy(true);
      await onConfirm?.();
    } finally {
      setInternalBusy(false);
    }
  };

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent
        className="w-[calc(100vw-1rem)] max-w-lg"
        onOpenAutoFocus={confirmPhrase ? (event) => {
          // Start in the phrase field rather than on Cancel.
          event.preventDefault();
          document.getElementById('confirm-action-phrase')?.focus();
        } : undefined}
      >
        <AlertDialogHeader>
          <AlertDialogTitle className={destructive ? 'text-red-200' : 'text-mil-bright'}>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        {confirmPhrase && (
          <form
            className="space-y-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (!phraseMissing && !isBusy) handleConfirm();
            }}
          >
            <Label htmlFor="confirm-action-phrase" className="text-sm text-mil-soft">
              Type <span className="font-mono text-red-200">{confirmPhrase}</span> to confirm (capitals)
            </Label>
            <Input
              id="confirm-action-phrase"
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              className="h-11 font-mono"
            />
          </form>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isBusy} className="border-mil-line bg-transparent text-mil-soft hover:bg-mil-bg-elevated hover:text-mil-bright">
            {cancelLabel}
          </AlertDialogCancel>
          <AlertDialogAction
            disabled={isBusy || phraseMissing}
            onClick={(event) => {
              event.preventDefault();
              if (phraseMissing) return;
              handleConfirm();
            }}
            className={cn(
              destructive
                ? 'border border-red-500/30 bg-red-500/15 text-red-100 hover:bg-red-500/25'
                : 'bg-brand text-mil-bg-deep hover:bg-brand-light',
            )}
          >
            {isBusy ? 'Working...' : confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

// Shared interaction floor for every command button: smooth hover + a
// visible keyboard-focus ring (accessibility quality floor). Tone-matched ring
// so a focused danger action reads red, not gold.
const BTN_BASE =
  'rounded-md transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-1 focus-visible:ring-offset-mil-bg-deep';

export function commandButtonClass({ active = false, danger = false } = {}) {
  if (danger) return `${BTN_BASE} focus-visible:ring-red-400/60 border-red-500/30 bg-red-500/10 text-red-200 hover:bg-red-500/20`;
  if (active) return `${BTN_BASE} focus-visible:ring-brand-light/60 border-brand bg-brand text-mil-bg-deep hover:bg-brand-light`;
  return `${BTN_BASE} focus-visible:ring-brand/50 border-mil-line bg-transparent text-mil-soft hover:border-mil-line-strong hover:bg-mil-bg-elevated hover:text-mil-bright`;
}
