// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import useConfirmDialog from './useConfirmDialog';

function Harness({ onReady }) {
  const { confirm, dialog } = useConfirmDialog();
  onReady(confirm);
  return <div>{dialog}</div>;
}

describe('useConfirmDialog', () => {
  afterEach(() => cleanup());
  it('resolves true on confirm and false on cancel', async () => {
    let confirm;
    render(<Harness onReady={(fn) => { confirm = fn; }} />);

    let first;
    act(() => { first = confirm({ title: 'Delete it?', confirmLabel: 'Delete' }); });
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));
    await expect(first).resolves.toBe(true);

    let second;
    act(() => { second = confirm({ title: 'Delete again?' }); });
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    await expect(second).resolves.toBe(false);
  });

  it('settles a pending confirm as false when a second one replaces it', async () => {
    let confirm;
    render(<Harness onReady={(fn) => { confirm = fn; }} />);

    let first;
    let second;
    act(() => { first = confirm({ title: 'First?' }); });
    act(() => { second = confirm({ title: 'Second?', confirmLabel: 'Yes' }); });
    await expect(first).resolves.toBe(false);
    expect(await screen.findByText('Second?')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Yes' }));
    await expect(second).resolves.toBe(true);
  });

  it('settles a pending confirm as false on unmount', async () => {
    let confirm;
    const { unmount } = render(<Harness onReady={(fn) => { confirm = fn; }} />);
    let pending;
    act(() => { pending = confirm({ title: 'Leaving?' }); });
    unmount();
    await expect(pending).resolves.toBe(false);
  });

  it('keeps confirm disabled until a required phrase is typed', async () => {
    let confirm;
    render(<Harness onReady={(fn) => { confirm = fn; }} />);
    let pending;
    act(() => { pending = confirm({ title: 'Clear all?', confirmLabel: 'Clear all logs', confirmPhrase: 'CLEAR' }); });
    const action = await screen.findByRole('button', { name: 'Clear all logs' });
    expect(action).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/to confirm/i), { target: { value: 'clear' } });
    expect(action).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/to confirm/i), { target: { value: 'CLEAR' } });
    expect(action).not.toBeDisabled();
    fireEvent.click(action);
    await expect(pending).resolves.toBe(true);
  });

  it('starts in the phrase field and confirms on Enter once the phrase matches', async () => {
    let confirm;
    render(<Harness onReady={(fn) => { confirm = fn; }} />);
    let pending;
    act(() => { pending = confirm({ title: 'Clear all?', confirmLabel: 'Clear all logs', confirmPhrase: 'CLEAR' }); });
    const field = await screen.findByLabelText(/to confirm/i);
    await waitFor(() => expect(document.activeElement).toBe(field));
    fireEvent.change(field, { target: { value: 'CLEAR' } });
    fireEvent.submit(field.closest('form'));
    await expect(pending).resolves.toBe(true);
  });
});
