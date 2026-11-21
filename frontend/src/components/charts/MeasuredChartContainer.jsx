import React, { useEffect, useRef, useState } from 'react';
import { BarChart3 } from 'lucide-react';

function DefaultChartSizingState() {
  return (
    <div className="flex h-full min-h-0 w-full min-w-0 items-center justify-center text-mil-dim">
      <div className="flex items-center gap-2 text-xs font-medium">
        <BarChart3 className="h-4 w-4" />
        Preparing chart
      </div>
    </div>
  );
}

function MeasuredChartContainer({
  children,
  className = '',
  fallback = null,
  minHeight = 40,
  minWidth = 40,
  observeKey,
}) {
  const containerRef = useRef(null);
  const [bounds, setBounds] = useState({ width: 0, height: 0 });

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return undefined;

    let frameId = null;

    const measure = () => {
      const next = {
        width: element.clientWidth || 0,
        height: element.clientHeight || 0,
      };

      setBounds((current) => {
        if (current.width === next.width && current.height === next.height) {
          return current;
        }
        return next;
      });
    };

    const scheduleMeasure = () => {
      if (frameId != null) {
        cancelAnimationFrame(frameId);
      }
      frameId = requestAnimationFrame(() => {
        frameId = null;
        measure();
      });
    };

    scheduleMeasure();

    let resizeObserver;
    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(() => {
        scheduleMeasure();
      });
      resizeObserver.observe(element);
    }

    window.addEventListener('resize', scheduleMeasure);

    return () => {
      window.removeEventListener('resize', scheduleMeasure);
      if (resizeObserver) {
        resizeObserver.disconnect();
      }
      if (frameId != null) {
        cancelAnimationFrame(frameId);
      }
    };
  }, [observeKey]);

  const ready = bounds.width >= minWidth && bounds.height >= minHeight;

  return (
    <div ref={containerRef} className={`w-full min-w-0 ${className}`.trim()}>
      {ready
        ? (typeof children === 'function' ? children(bounds) : children)
        : (fallback || <DefaultChartSizingState />)}
    </div>
  );
}

export default MeasuredChartContainer;