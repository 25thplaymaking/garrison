import React, { Suspense, useEffect } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider, useAuth } from '@/context/AuthContext';
import { Toaster } from '@/components/ui/toaster';
import ErrorBoundary from '@/components/ErrorBoundary';
import TacticalLoadingScreen from '@/components/tactical/TacticalLoadingScreen';
import AppLayout from '@/components/layout/AppLayout';
import { lazyWithRetry } from '@/utils/lazyWithRetry';
import { UNAUTHORIZED_EVENT } from '@/lib/apiClient';
import { hasPermission, PERMISSIONS } from '@/utils/permissions';

const LoginPage = lazyWithRetry(() => import('@/pages/LoginPage'));
const AccountsPage = lazyWithRetry(() => import('@/pages/AccountsPage'));
const AuditLogPage = lazyWithRetry(() => import('@/pages/AuditLogPage'));
const MyAccountPage = lazyWithRetry(() => import('@/pages/MyAccountPage'));
const ServerHub = lazyWithRetry(() => import('@/pages/servers/ServerHub'));
const ServerWorkspace = lazyWithRetry(() => import('@/pages/servers/ServerWorkspace'));
const OverviewModule = lazyWithRetry(() => import('@/pages/servers/modules/OverviewModule'));
const LiveControlModule = lazyWithRetry(() => import('@/pages/servers/modules/LiveControlModule'));
const PlayersMetricsModule = lazyWithRetry(() => import('@/pages/servers/modules/PlayersMetricsModule'));
const ModsWorkspaceModule = lazyWithRetry(() => import('@/pages/servers/modules/ModsWorkspaceModule'));
const AutomationModule = lazyWithRetry(() => import('@/pages/servers/modules/AutomationModule'));
const ServerConfigWorkspaceModule = lazyWithRetry(() => import('@/pages/servers/modules/ServerConfigWorkspaceModule'));
const SystemSettingsModule = lazyWithRetry(() => import('@/pages/servers/modules/SystemSettingsModule'));
const ConfigHealthModule = lazyWithRetry(() => import('@/pages/servers/modules/ConfigHealthModule'));
const OpsLogModule = lazyWithRetry(() => import('@/pages/servers/modules/OpsLogModule'));
const HealthAlertsModule = lazyWithRetry(() => import('@/pages/servers/modules/HealthAlertsModule'));
const CrashAnalysisModule = lazyWithRetry(() => import('@/pages/servers/modules/CrashAnalysisModule'));
const ScriptBudgetModule = lazyWithRetry(() => import('@/pages/servers/modules/ScriptBudgetModule'));
const FileManagerModule = lazyWithRetry(() => import('@/pages/servers/modules/FileManagerModule'));
const ReportsModule = lazyWithRetry(() => import('@/pages/servers/modules/ReportsModule'));

const queryClient = new QueryClient({
  defaultOptions: { queries: { refetchOnWindowFocus: false, retry: 1 } },
});

function Protected({ permission, children }) {
  const { user, checking } = useAuth();
  const location = useLocation();
  if (checking) return <TacticalLoadingScreen mode="fullscreen" label="Checking your session…" />;
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  if (permission && !hasPermission(user.role, permission)) return <Navigate to="/servers" replace />;
  return children;
}

/** A 401 from any request means the session ended: drop to the sign-in page. */
function SessionWatcher() {
  const { user, logout } = useAuth();
  useEffect(() => {
    const onUnauthorized = () => { if (user) logout(); };
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
  }, [user, logout]);
  return null;
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <BrowserRouter>
          <SessionWatcher />
          <ErrorBoundary>
            <Suspense fallback={<TacticalLoadingScreen mode="fullscreen" label="Loading…" />}>
              <Routes>
                <Route path="/login" element={<LoginPage />} />
                <Route element={<Protected><AppLayout /></Protected>}>
                  <Route path="/" element={<Navigate to="/servers" replace />} />
                  <Route path="/servers" element={<Protected permission={PERMISSIONS.MANAGE_SERVERS}><ServerHub /></Protected>} />
                  <Route path="/servers/:id" element={<Protected permission={PERMISSIONS.MANAGE_SERVERS}><ErrorBoundary><ServerWorkspace /></ErrorBoundary></Protected>}>
                    <Route index element={<OverviewModule />} />
                    <Route path="console" element={<LiveControlModule initialTab="console" />} />
                    <Route path="rcon" element={<LiveControlModule initialTab="rcon" />} />
                    <Route path="players" element={<PlayersMetricsModule initialTab="players" />} />
                    <Route path="metrics" element={<PlayersMetricsModule initialTab="metrics" />} />
                    <Route path="mods" element={<ModsWorkspaceModule initialTab="mods" />} />
                    <Route path="schedules" element={<AutomationModule />} />
                    <Route path="config/server" element={<ServerConfigWorkspaceModule initialTab="server" />} />
                    <Route path="config/system" element={<SystemSettingsModule />} />
                    <Route path="config/health" element={<ConfigHealthModule />} />
                    <Route path="config/admin-tools" element={<ServerConfigWorkspaceModule initialTab="admin-tools" />} />
                    <Route path="tools/files" element={<FileManagerModule />} />
                    <Route path="tools/reports" element={<ReportsModule />} />
                    <Route path="tools/todos" element={<OpsLogModule initialTab="tasks" />} />
                    <Route path="diagnosis" element={<CrashAnalysisModule />} />
                    <Route path="script-budget" element={<ScriptBudgetModule />} />
                    <Route path="tools/watchers" element={<HealthAlertsModule initialTab="watchers" />} />
                    <Route path="tools/compare" element={<ModsWorkspaceModule initialTab="compare" />} />
                    <Route path="admin/notes" element={<OpsLogModule initialTab="notes" />} />
                    <Route path="admin/notifications" element={<HealthAlertsModule initialTab="notifications" />} />
                    <Route path="admin/incidents" element={<HealthAlertsModule initialTab="incidents" />} />
                  </Route>
                  <Route path="/account" element={<MyAccountPage />} />
                  <Route path="/accounts" element={<Protected permission={PERMISSIONS.MANAGE_USERS}><AccountsPage /></Protected>} />
                  <Route path="/audit" element={<Protected permission={PERMISSIONS.MANAGE_USERS}><AuditLogPage /></Protected>} />
                  <Route path="*" element={<Navigate to="/servers" replace />} />
                </Route>
              </Routes>
            </Suspense>
          </ErrorBoundary>
          <Toaster />
        </BrowserRouter>
      </AuthProvider>
    </QueryClientProvider>
  );
}
