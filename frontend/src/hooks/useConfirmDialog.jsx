import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ConfirmActionDialog } from '@/components/tactical/CommandUI';

/**
 * Promise-based confirm dialog hook. Replaces the native browser confirm API
 * with the shared themed ConfirmActionDialog while keeping a one-liner call
 * shape at the call site:
 *
 *   const { confirm, dialog: confirmDialog } = useConfirmDialog();
 *   if (!(await confirm({ title: 'Delete?', description: '...' }))) return;
 *   // ...and render {confirmDialog} once in the component's JSX.
 *
 * A wired confirm with no rendered dialog never resolves, so always render
 * `dialog`. Resolves to `true` if the user confirms, `false` if they cancel
 * or dismiss.
 *
 * Only one confirm is open at a time per consumer: a second `confirm()` call
 * settles the pending one as `false` before replacing it, and unmounting
 * settles any pending confirm as `false`, so no caller is left awaiting a
 * promise that can never resolve.
 *
 * Why a hook (not a global provider): each consumer owns its own dialog
 * state, so concurrent confirms from sibling pages don't fight each other.
 */
export default function useConfirmDialog() {
  const [state, setState] = useState(null);
  const pendingRef = useRef(null);

  const settle = useCallback((value) => {
    const resolve = pendingRef.current;
    pendingRef.current = null;
    if (resolve) resolve(value);
  }, []);

  useEffect(() => () => settle(false), [settle]);

  const confirm = useCallback((opts) => {
    settle(false);
    return new Promise((resolve) => {
      pendingRef.current = resolve;
      setState({
        title: opts?.title || 'Confirm action',
        description: opts?.description || 'This action will update records.',
        confirmLabel: opts?.confirmLabel || 'Confirm',
        cancelLabel: opts?.cancelLabel || 'Cancel',
        destructive: !!opts?.destructive,
        confirmPhrase: opts?.confirmPhrase || undefined,
      });
    });
  }, [settle]);

  const handleResolve = useCallback((value) => {
    settle(value);
    setState(null);
  }, [settle]);

  // Radix keeps the dialog on screen for its fade-out after `state` clears;
  // render that frame from the last prompt, not the generic defaults.
  const lastPromptRef = useRef(null);
  if (state) lastPromptRef.current = state;
  const prompt = state || lastPromptRef.current;

  const dialog = (
    <ConfirmActionDialog
      open={!!state}
      onOpenChange={(open) => { if (!open) handleResolve(false); }}
      title={prompt?.title}
      description={prompt?.description}
      confirmLabel={prompt?.confirmLabel}
      cancelLabel={prompt?.cancelLabel}
      destructive={!!prompt?.destructive}
      confirmPhrase={prompt?.confirmPhrase}
      onConfirm={() => handleResolve(true)}
    />
  );

  return { confirm, dialog };
}
