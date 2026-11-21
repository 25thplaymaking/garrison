import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import { Badge } from '@/components/ui/badge';
import { useUnsavedChanges } from '@/context/UnsavedChangesContext';
import { headingChild } from '@/utils/headingCase';

function ModuleTabs({ title, description, tabs, initialTab }) {
  const fallbackTab = tabs[0]?.id;
  // ?tab=<id> picks a tab, so links (and reloads) can land on one directly.
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedTab = searchParams.get('tab');
  const linkedTab = tabs.some((tab) => tab.id === requestedTab) ? requestedTab : null;
  const startTab = linkedTab || initialTab || fallbackTab;
  const [activeTab, setActiveTab] = useState(startTab);
  const { hasUnsavedChanges, confirmNavigation } = useUnsavedChanges();

  useEffect(() => {
    setActiveTab(startTab);
  }, [startTab]);

  const active = useMemo(
    () => tabs.find((tab) => tab.id === activeTab) || tabs[0],
    [activeTab, tabs],
  );

  const selectTab = useCallback((tabId) => {
    if (tabId === activeTab) return;
    const apply = () => {
      setActiveTab(tabId);
      setSearchParams((current) => {
        const next = new URLSearchParams(current);
        next.set('tab', tabId);
        return next;
      }, { replace: true });
    };
    if (hasUnsavedChanges) {
      confirmNavigation(apply);
      return;
    }
    apply();
  }, [activeTab, confirmNavigation, hasUnsavedChanges, setSearchParams]);

  if (!active) return null;

  const ActiveComponent = active.component;

  // One header band: the module name, the open tab's purpose, and the tabs.
  // The sidebar already names the section, so no eyebrow box or second
  // description strip is repeated here.
  const subtitle = active.description || description;

  return (
    <div className="space-y-4">
      <header className="border-b border-[rgba(232,131,58,0.12)]">
        <div className="min-w-0 pb-3">
          <h2 className="text-lg font-semibold text-mil-bright" style={{ fontFamily: "var(--font-heading)" }}>
            {headingChild(title)}
          </h2>
          {subtitle ? (
            <p className="mt-0.5 max-w-3xl text-xs leading-relaxed text-mil-muted">
              {subtitle}
            </p>
          ) : null}
        </div>

        {tabs.length > 1 ? (
          <div role="tablist" aria-label={`${title} sections`} className="-mb-px flex flex-wrap gap-x-1">
            {tabs.map((tab) => {
              const Icon = tab.icon;
              const isActive = active.id === tab.id;
              return (
                <button
                  key={tab.id}
                  type="button"
                  role="tab"
                  aria-selected={isActive}
                  onClick={() => selectTab(tab.id)}
                  className={`capitalize flex min-h-11 shrink-0 items-center gap-2 border-b-2 px-3 text-xs font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-brand sm:min-h-10 ${
 isActive
 ? 'border-brand-light text-brand-light'
 : 'border-transparent text-mil-muted hover:border-[rgba(232,131,58,0.3)] hover:text-mil-fg'
 }`}
                  style={{ fontFamily: "var(--font-condensed)" }}
                >
                  {Icon ? <Icon className="h-3.5 w-3.5" aria-hidden="true" /> : null}
                  {tab.label}
                  {tab.badge ? (
                    <Badge variant="outline" className="border-[rgba(232,131,58,0.2)] text-[11px] text-brand">
                      {tab.badge}
                    </Badge>
                  ) : null}
                </button>
              );
            })}
          </div>
        ) : null}
      </header>

      <ActiveComponent />
    </div>
  );
}

export default ModuleTabs;
