import React from 'react';

/**
 * Garrison's mark: a crenellated tower over a horizon line, drawn in the
 * brand colour. Inline SVG so it needs no image request and scales cleanly.
 */
export function GarrisonMark({ size = 32, className = '', title = 'Garrison' }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      role="img"
      aria-label={title}
      className={`shrink-0 ${className}`}
    >
      <title>{title}</title>
      <path
        d="M14 54V24h6v-8h6v8h4v-8h4v8h4v-8h6v8h6v30H38V42a6 6 0 0 0-12 0v12Z"
        fill="none"
        stroke="var(--color-brand-light)"
        strokeWidth="3"
        strokeLinejoin="round"
      />
      <path d="M6 56h52" stroke="var(--color-brand)" strokeWidth="3" strokeLinecap="round" />
      <path d="M32 6v8M28 10h8" stroke="var(--color-brand)" strokeWidth="2.5" strokeLinecap="round" />
    </svg>
  );
}

export function GarrisonLockup({ size = 28, className = '' }) {
  return (
    <span className={`inline-flex items-center gap-2 ${className}`}>
      <GarrisonMark size={size} />
      <span className="text-lg font-semibold tracking-wide text-mil-bright" style={{ fontFamily: 'var(--font-heading)' }}>
        Garrison
      </span>
    </span>
  );
}

export default GarrisonMark;
