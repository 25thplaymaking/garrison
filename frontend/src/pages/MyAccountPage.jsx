import React, { useState } from 'react';
import { KeyRound, Loader2 } from 'lucide-react';
import apiClient from '@/lib/apiClient';
import { auth } from '@/lib/endpoints';
import { useAuth } from '@/context/AuthContext';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { formatApiError } from '@/utils/errorMessages';

export default function MyAccountPage() {
  const { user } = useAuth();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null);

  const submit = async (event) => {
    event.preventDefault();
    if (next !== confirm) {
      setMessage({ ok: false, text: 'The new passwords do not match.' });
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      await apiClient.post(auth.password, { current_password: current, new_password: next });
      setCurrent('');
      setNext('');
      setConfirm('');
      setMessage({ ok: true, text: 'Password changed. Your other sessions were signed out.' });
    } catch (err) {
      setMessage({ ok: false, text: formatApiError(err, 'Could not change the password.') });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-xl">
      <h1 className="text-2xl font-semibold text-mil-bright">My account</h1>
      <p className="mt-1 text-sm text-mil-muted">
        Signed in as <span className="text-mil-fg">{user?.username}</span> ({user?.role}).
      </p>
      <form onSubmit={submit} className="mt-6 space-y-4 border border-mil-line bg-mil-bg-panel p-5">
        <h2 className="text-lg text-mil-bright">Change password</h2>
        <div className="space-y-1.5">
          <Label htmlFor="current">Current password</Label>
          <Input id="current" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="next">New password (at least 10 characters)</Label>
          <Input id="next" type="password" autoComplete="new-password" minLength={10} value={next} onChange={(e) => setNext(e.target.value)} required />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="confirm">New password again</Label>
          <Input id="confirm" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
        </div>
        {message && <p role="status" className={`text-sm ${message.ok ? 'text-green-400' : 'text-red-300'}`}>{message.text}</p>}
        <Button type="submit" variant="commandPrimary" disabled={busy}>
          {busy ? <Loader2 className="animate-spin" aria-hidden="true" /> : <KeyRound aria-hidden="true" />}
          Change password
        </Button>
      </form>
    </div>
  );
}
