import React, { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';

const UnsavedChangesContext = createContext(null);

export function UnsavedChangesProvider({ children }) {
  const [sources, setSources] = useState({});
  const [pendingNavigation, setPendingNavigation] = useState(null);
  const [saving, setSaving] = useState(false);
  const sourcesRef = useRef({});

  const setSourcesState = useCallback((updater) => {
    setSources((current) => {
      const next = typeof updater === 'function' ? updater(current) : updater;
      sourcesRef.current = next;
      return next;
    });
  }, []);

  const registerDirtySource = useCallback((source) => {
    if (!source?.id) return () => {};
    setSourcesState((current) => ({
      ...current,
      [source.id]: {
        id: source.id,
        label: source.label || source.id,
        summary: source.summary || '',
        dirty: Boolean(source.dirty),
        onSave: source.onSave,
        onDiscard: source.onDiscard,
        onSaved: source.onSaved,
      },
    }));

    return () => {
      setSourcesState((current) => {
        if (!current[source.id]) return current;
        const next = { ...current };
        delete next[source.id];
        return next;
      });
    };
  }, [setSourcesState]);

  const dirtySources = useMemo(
    () => Object.values(sources).filter((source) => source.dirty),
    [sources],
  );
  const hasUnsavedChanges = dirtySources.length > 0;

  const refreshDirtySources = useCallback(
    () => Object.values(sourcesRef.current).filter((source) => source.dirty),
    [],
  );

  const markSourcesSaved = useCallback(async (ids = []) => {
    const idSet = new Set(ids);
    const activeDirtySources = refreshDirtySources().filter((source) => (
      idSet.size === 0 || idSet.has(source.id)
    ));
    for (const source of activeDirtySources) {
      await source.onSaved?.();
    }
    setSourcesState((current) => {
      const next = { ...current };
      activeDirtySources.forEach((source) => {
        if (next[source.id]) {
          next[source.id] = { ...next[source.id], dirty: false };
        }
      });
      return next;
    });
  }, [refreshDirtySources, setSourcesState]);

  const confirmNavigation = useCallback((navigateAction) => {
    const activeDirtySources = refreshDirtySources();
    if (activeDirtySources.length === 0) {
      navigateAction?.();
      return true;
    }
    setPendingNavigation({ navigateAction, dirtySources: activeDirtySources });
    return false;
  }, [refreshDirtySources]);

  // Save every dirty tab through its own save handler, in order. Stops at the
  // first one that reports failure (returns false) so nothing is skipped silently.
  const saveAll = useCallback(async () => {
    setSaving(true);
    try {
      for (const source of refreshDirtySources()) {
        if (typeof source.onSave === 'function') {
          const result = await source.onSave();
          if (result === false) return false;
        }
      }
      return true;
    } finally {
      setSaving(false);
    }
  }, [refreshDirtySources]);

  const closePendingNavigation = useCallback(() => {
    if (saving) return;
    setPendingNavigation(null);
  }, [saving]);

  const leaveNow = useCallback(async () => {
    const pending = pendingNavigation;
    if (!pending) return;
    for (const source of pending.dirtySources) {
      await source.onDiscard?.();
    }
    setPendingNavigation(null);
    pending.navigateAction?.();
  }, [pendingNavigation]);

  const saveAndLeave = useCallback(async () => {
    const pending = pendingNavigation;
    if (!pending) return;
    setSaving(true);
    try {
      for (const source of pending.dirtySources) {
        if (typeof source.onSave === 'function') {
          const result = await source.onSave();
          if (result === false) return;
        }
      }
      setPendingNavigation(null);
      pending.navigateAction?.();
    } finally {
      setSaving(false);
    }
  }, [pendingNavigation]);

  const value = useMemo(() => ({
    dirtySources,
    hasUnsavedChanges,
    pendingNavigation,
    saving,
    registerDirtySource,
    markSourcesSaved,
    saveAll,
    confirmNavigation,
    closePendingNavigation,
    leaveNow,
    saveAndLeave,
  }), [
    closePendingNavigation,
    confirmNavigation,
    dirtySources,
    hasUnsavedChanges,
    leaveNow,
    markSourcesSaved,
    pendingNavigation,
    registerDirtySource,
    saveAll,
    saveAndLeave,
    saving,
  ]);

  return (
    <UnsavedChangesContext.Provider value={value}>
      {children}
    </UnsavedChangesContext.Provider>
  );
}

export function useUnsavedChanges() {
  const context = useContext(UnsavedChangesContext);
  if (!context) {
    throw new Error('useUnsavedChanges must be used inside an UnsavedChangesProvider');
  }
  return context;
}
