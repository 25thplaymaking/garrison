import React, { useCallback, useEffect, useState } from 'react';
import { KeyRound, Loader2, Trash2, UserPlus } from 'lucide-react';
import apiClient from '@/lib/apiClient';
import { users as usersApi } from '@/lib/endpoints';
import { useAuth } from '@/context/AuthContext';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import useConfirmDialog from '@/hooks/useConfirmDialog';
import { formatApiError } from '@/utils/errorMessages';

const ROLE_HELP = {
  admin: 'Servers, accounts and the audit log',
  operator: 'Servers only',
};

function formatWhen(value) {
  if (!value) return 'Never';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

export default function AccountsPage() {
  const { user: me } = useAuth();
  const { confirm, dialog: confirmDialog } = useConfirmDialog();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [form, setForm] = useState({ username: '', password: '', role: 'operator' });
  const [creating, setCreating] = useState(false);
  const [resetFor, setResetFor] = useState(null);
  const [resetPassword, setResetPassword] = useState('');

  const load = useCallback(async () => {
    try {
      const { data } = await apiClient.get(usersApi.list);
      setRows(data);
      setError('');
    } catch (err) {
      setError(formatApiError(err, 'Could not load accounts.'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const update = async (id, body) => {
    try {
      await apiClient.patch(usersApi.one(id), body);
      await load();
      return true;
    } catch (err) {
      setError(formatApiError(err, 'Could not update the account.'));
      return false;
    }
  };

  const create = async (event) => {
    event.preventDefault();
    setCreating(true);
    try {
      await apiClient.post(usersApi.list, form);
      setForm({ username: '', password: '', role: 'operator' });
      await load();
      setError('');
    } catch (err) {
      setError(formatApiError(err, 'Could not create the account.'));
    } finally {
      setCreating(false);
    }
  };

  const remove = async (row) => {
    const ok = await confirm({
      title: `Delete ${row.username}?`,
      description: 'The account is removed and signed out. This cannot be undone.',
      confirmLabel: 'Delete account',
      destructive: true,
    });
    if (!ok) return;
    try {
      await apiClient.delete(usersApi.one(row.id));
      await load();
    } catch (err) {
      setError(formatApiError(err, 'Could not delete the account.'));
    }
  };

  const submitReset = async (event) => {
    event.preventDefault();
    if (await update(resetFor.id, { password: resetPassword })) {
      setResetFor(null);
      setResetPassword('');
    }
  };

  return (
    <div className="mx-auto max-w-5xl">
      <h1 className="text-2xl font-semibold text-mil-bright">Accounts</h1>
      <p className="mt-1 text-sm text-mil-muted">Who can sign in to this panel. Admins manage servers and accounts; operators manage servers.</p>

      {error && <p role="alert" className="mt-4 border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-200">{error}</p>}

      <form onSubmit={create} className="mt-6 grid gap-3 border border-mil-line bg-mil-bg-panel p-4 md:grid-cols-[1fr_1fr_10rem_auto] md:items-end">
        <div className="space-y-1.5">
          <Label htmlFor="new-username">Username</Label>
          <Input id="new-username" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} required minLength={3} maxLength={32} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="new-password">Password (10+ characters)</Label>
          <Input id="new-password" type="password" autoComplete="new-password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} required minLength={10} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="new-role">Role</Label>
          <select id="new-role" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })} className="h-9 w-full border border-input bg-mil-bg-deep px-2 text-sm text-mil-fg">
            <option value="operator">Operator</option>
            <option value="admin">Admin</option>
          </select>
        </div>
        <Button type="submit" variant="commandPrimary" disabled={creating}>
          {creating ? <Loader2 className="animate-spin" aria-hidden="true" /> : <UserPlus aria-hidden="true" />}
          Add account
        </Button>
      </form>

      <div className="mt-6 overflow-x-auto border border-mil-line">
        <table className="w-full text-sm">
          <thead className="bg-mil-bg-panel text-left text-xs text-mil-muted">
            <tr>
              <th className="px-3 py-2 font-medium">Username</th>
              <th className="px-3 py-2 font-medium">Role</th>
              <th className="px-3 py-2 font-medium">Active</th>
              <th className="px-3 py-2 font-medium">Last sign-in</th>
              <th className="px-3 py-2 font-medium"><span className="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td colSpan={5} className="px-3 py-6 text-center text-mil-muted"><Loader2 className="mx-auto h-5 w-5 animate-spin" aria-label="Loading" /></td></tr>
            )}
            {rows.map((row) => (
              <tr key={row.id} className="border-t border-mil-line">
                <td className="px-3 py-2 text-mil-fg">{row.username}{row.id === me?.id && <span className="ml-2 text-xs text-mil-dim">(you)</span>}</td>
                <td className="px-3 py-2">
                  <select
                    aria-label={`Role for ${row.username}`}
                    value={row.role}
                    onChange={(e) => update(row.id, { role: e.target.value })}
                    className="h-8 border border-input bg-mil-bg-deep px-2 text-sm text-mil-fg"
                    title={ROLE_HELP[row.role]}
                  >
                    <option value="operator">Operator</option>
                    <option value="admin">Admin</option>
                  </select>
                </td>
                <td className="px-3 py-2">
                  <Switch
                    aria-label={`${row.username} can sign in`}
                    checked={row.is_active}
                    disabled={row.id === me?.id}
                    onCheckedChange={(checked) => update(row.id, { is_active: checked })}
                  />
                </td>
                <td className="px-3 py-2 text-mil-muted">{formatWhen(row.last_login_at)}</td>
                <td className="px-3 py-2">
                  <div className="flex justify-end gap-1">
                    <Button type="button" size="sm" variant="commandOutline" onClick={() => { setResetFor(row); setResetPassword(''); }}>
                      <KeyRound aria-hidden="true" /> Reset password
                    </Button>
                    {row.id !== me?.id && (
                      <Button type="button" size="sm" variant="commandDanger" onClick={() => remove(row)} aria-label={`Delete ${row.username}`}>
                        <Trash2 aria-hidden="true" />
                      </Button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {resetFor && (
        <form onSubmit={submitReset} className="mt-4 flex flex-wrap items-end gap-3 border border-mil-line bg-mil-bg-panel p-4">
          <div className="min-w-64 flex-1 space-y-1.5">
            <Label htmlFor="reset-password">New password for {resetFor.username}</Label>
            <Input id="reset-password" type="password" autoComplete="new-password" minLength={10} value={resetPassword} onChange={(e) => setResetPassword(e.target.value)} required autoFocus />
          </div>
          <Button type="submit" variant="commandPrimary">Set password</Button>
          <Button type="button" variant="commandOutline" onClick={() => setResetFor(null)}>Cancel</Button>
        </form>
      )}
      {confirmDialog}
    </div>
  );
}
