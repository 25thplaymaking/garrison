import React from 'react';
import { lazyWithRetry } from '@/utils/lazyWithRetry';
import { Server, AlertTriangle, BarChart3, Key, ShieldCheck } from 'lucide-react';
import TabbedWorkspace from '@/components/tactical/TabbedWorkspace';
import { hasPermission, PERMISSIONS } from '@/utils/permissions';

const ServerDashboard = lazyWithRetry(() => import('./ServerDashboard'));
const ConfigHealthConsole = lazyWithRetry(() => import('./ConfigHealthConsole'));
const ServerDiagnostics = lazyWithRetry(() => import('./ServerDiagnostics'));
const ServerStatistics = lazyWithRetry(() => import('./ServerStatistics'));
const IntegrationsModule = lazyWithRetry(() => import('./modules/IntegrationsModule'));

const canManage = (role) => hasPermission(role, PERMISSIONS.MANAGE_SERVERS);

const TABS = [
  {
    id: 'dashboard',
    label: 'Fleet',
    icon: Server,
    tone: 'gold',
    description: 'Every server: status, players, controls, and creating new ones.',
    Component: ServerDashboard,
    show: canManage,
  },
  {
    id: 'health',
    label: 'Config Health',
    icon: ShieldCheck,
    tone: 'gold',
    description: 'Live verdict, config file detection and config rules for every server.',
    Component: ConfigHealthConsole,
    show: canManage,
  },
  {
    id: 'statistics',
    label: 'Statistics',
    icon: BarChart3,
    tone: 'gold',
    description: 'Server performance history and runtime details.',
    Component: ServerStatistics,
    show: canManage,
  },
  {
    id: 'diagnostics',
    label: 'Diagnostics',
    icon: AlertTriangle,
    tone: 'red',
    description: 'Fleet-wide diagnostics, mod issues, and log monitoring.',
    Component: ServerDiagnostics,
    show: canManage,
  },
  {
    id: 'integrations',
    label: 'Integrations',
    icon: Key,
    tone: 'gold',
    description: 'Outside services the server tools use, such as the public server list behind Compare and Mirror.',
    Component: IntegrationsModule,
    show: canManage,
  },
];

export default function ServerHub() {
  return (
    <TabbedWorkspace
      title="Servers"
      description="Your Arma Reforger fleet: status, config health, statistics and diagnostics."
      tabs={TABS}
      defaultTabId="dashboard"
    />
  );
}
