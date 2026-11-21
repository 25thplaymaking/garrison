import React, { useState } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router';
import { Loader2, LogIn } from 'lucide-react';
import apiClient from '@/lib/apiClient';
import { auth } from '@/lib/endpoints';
import { useAuth } from '@/context/AuthContext';
import { GarrisonMark } from '@/components/brand/GarrisonMark';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { formatApiError } from '@/utils/errorMessages';

export default function LoginPage() {
  const { user, login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const next = location.state?.from || '/servers';

  if (user) return <Navigate to={next} replace />;

  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const { data } = await apiClient.post(auth.login, { username, password });
      login(data);
      navigate(next, { replace: true });
    } catch (err) {
      setError(formatApiError(err, 'Sign-in failed.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-mil-bg-deep px-4">
      <form onSubmit={submit} className="w-full max-w-sm border border-mil-line bg-mil-bg-panel p-6" aria-labelledby="login-title">
        <div className="mb-6 flex flex-col items-center gap-3 text-center">
          <GarrisonMark size={56} />
          <h1 id="login-title" className="text-2xl font-semibold text-mil-bright">Garrison</h1>
          <p className="text-sm text-mil-muted">Arma Reforger server panel</p>
        </div>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="username">Username</Label>
            <Input id="username" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} required autoFocus />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="password">Password</Label>
            <Input id="password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          </div>
          {error && <p role="alert" className="text-sm text-red-300">{error}</p>}
          <Button type="submit" variant="commandPrimary" className="w-full" disabled={busy}>
            {busy ? <Loader2 className="animate-spin" aria-hidden="true" /> : <LogIn aria-hidden="true" />}
            Sign in
          </Button>
        </div>
      </form>
    </div>
  );
}
