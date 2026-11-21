import React from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router';
import { LogOut, ScrollText, Server, UserCog, Users } from 'lucide-react';
import { useAuth } from '@/context/AuthContext';
import { GarrisonLockup } from '@/components/brand/GarrisonMark';
import { hasPermission, PERMISSIONS } from '@/utils/permissions';

const LINK = 'inline-flex min-h-11 items-center gap-2 border-b-2 px-3 text-sm transition-colors';
const linkClass = ({ isActive }) => `${LINK} ${isActive
  ? 'border-brand-light text-brand-light'
  : 'border-transparent text-mil-muted hover:text-mil-fg'}`;

export default function AppLayout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const isAdmin = hasPermission(user?.role, PERMISSIONS.MANAGE_USERS);

  const signOut = async () => {
    await logout();
    navigate('/login', { replace: true });
  };

  return (
    <div className="min-h-screen bg-mil-bg-deep text-mil-fg">
      <header className="sticky top-0 z-40 border-b border-mil-line bg-mil-bg-panel/95 backdrop-blur" style={{ height: 'var(--shell-nav-h, 3.5rem)' }}>
        <div className="mx-auto flex h-full max-w-[1800px] items-center gap-4 px-4">
          <NavLink to="/servers" aria-label="Garrison home"><GarrisonLockup size={26} /></NavLink>
          <nav aria-label="Main" className="flex h-full items-stretch">
            <NavLink to="/servers" className={linkClass}><Server className="h-4 w-4" aria-hidden="true" />Servers</NavLink>
            {isAdmin && <NavLink to="/accounts" className={linkClass}><Users className="h-4 w-4" aria-hidden="true" />Accounts</NavLink>}
            {isAdmin && <NavLink to="/audit" className={linkClass}><ScrollText className="h-4 w-4" aria-hidden="true" />Audit log</NavLink>}
          </nav>
          <div className="ml-auto flex items-center gap-1">
            <NavLink to="/account" className={linkClass} title="My account">
              <UserCog className="h-4 w-4" aria-hidden="true" />
              <span className="hidden sm:inline">{user?.username}</span>
              <span className="hidden text-xs text-mil-dim md:inline">({user?.role})</span>
            </NavLink>
            <button
              type="button"
              onClick={signOut}
              className="inline-flex min-h-11 items-center gap-2 px-3 text-sm text-mil-muted transition-colors hover:text-mil-fg"
            >
              <LogOut className="h-4 w-4" aria-hidden="true" />
              <span className="hidden sm:inline">Sign out</span>
            </button>
          </div>
        </div>
      </header>
      {/* Same padding the server pages were designed inside. */}
      <main id="main-content" className="min-w-0 overflow-x-clip p-4 md:p-8">
        <Outlet />
      </main>
    </div>
  );
}
