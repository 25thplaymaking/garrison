import React from 'react';

import { isChunkLoadError } from '@/utils/lazyWithRetry';

/**
 * Generic React Error Boundary.
 *
 * Catches JavaScript errors in child component trees and renders a fallback UI
 * instead of crashing the entire application.
 *
 * Usage:
 *   <ErrorBoundary fallback={<p>Something went wrong</p>}>
 *     <MyComponent />
 *   </ErrorBoundary>
 *
 * Pass `resetKey` (e.g. the route path) to clear the error when it changes, so
 * navigating away from a broken page recovers without a full reload.
 *
 * A stale code chunk is called out separately. `lazyWithRetry` already reloads
 * once for those, so reaching here means the reload did not help — telling the
 * user their tab is running against a replaced build is far more actionable
 * than "something went wrong", and stops it being reported as a page bug.
 */
export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidUpdate(prevProps) {
    if (this.state.hasError && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ hasError: false, error: null });
    }
  }

  componentDidCatch(error, info) {
    // Errors are logged to console. Add an error reporting service
    // (e.g. Sentry) here for production visibility.
    console.error('[ErrorBoundary] Uncaught error:', error, info?.componentStack);
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }

      const staleBuild = isChunkLoadError(this.state.error);

      return (
        <div className="min-h-screen flex items-center justify-center bg-mil-bg-deep text-mil-fg">
          <div className="max-w-lg rounded-2xl border border-red-500/25 bg-[#121212] p-8 text-center shadow-2xl">
            <p className="text-xs font-medium text-red-300 capitalize">
              {staleBuild ? 'Update Required' : 'Rendering Error'}
            </p>
            <p className="mt-3 text-xl font-semibold text-brand-light">
              {staleBuild ? 'This page is running an old version' : 'Something went wrong'}
            </p>
            <p className="mt-3 text-sm text-mil-muted">
              {staleBuild
                ? 'A new version of the site was deployed while this tab was open, so part of it could no longer be loaded. Reloading will pick up the current version.'
                : 'An unexpected error prevented this page from rendering. Try refreshing the page.'}
            </p>
            <button
              onClick={() => window.location.reload()}
              className="mt-5 rounded-lg border border-brand-light/30 bg-brand-light/10 px-5 py-2 text-sm font-semibold text-brand-light transition hover:bg-brand-light/20"
            >
              Reload Page
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
