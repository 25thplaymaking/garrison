import React, { useState, useEffect, useCallback } from 'react';
import { useOutletContext } from 'react-router';
import apiClient from '@/lib/apiClient';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import {
  Bell,
  CheckCircle2,
  ClipboardList,
  AlertTriangle,
  Loader2,
} from 'lucide-react';
import useConfirmDialog from '@/hooks/useConfirmDialog';
import { formatApiError } from '@/utils/errorMessages';
import { parseServerDate } from '@/utils/serverStatus';

const SEVERITY_STYLES = {
  info: 'border-sky-600/20 bg-sky-600/5 text-sky-300',
  warning: 'border-amber-600/20 bg-amber-600/5 text-amber-300',
  error: 'border-orange-600/20 bg-orange-600/5 text-orange-300',
  critical: 'border-red-600/20 bg-red-600/5 text-red-300',
};

function NotificationsModule() {
  const { serverId } = useOutletContext();
  const { confirm, dialog: confirmDialog } = useConfirmDialog();
  const [notifications, setNotifications] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [actionError, setActionError] = useState('');
  const [showCleared, setShowCleared] = useState(false);
  const [notificationAction, setNotificationAction] = useState(null);

  const fetchModuleData = useCallback(async ({ silent = false } = {}) => {
    if (!silent) setLoading(true);
    try {
      const res = await apiClient.get(`/servers/${serverId}/notifications`, {
        params: { include_cleared: showCleared },
      });
      setNotifications(res.data?.notifications || []);
      setLoadError('');
    } catch (err) {
      // A failed load used to render the green "No actionable notifications".
      setLoadError(formatApiError(err, 'Could not load server notifications.'));
    } finally {
      if (!silent) setLoading(false);
    }
  }, [serverId, showCleared]);

  useEffect(() => {
    fetchModuleData();
  }, [fetchModuleData]);

  const acknowledgeNotification = useCallback(async (notificationId) => {
    setNotificationAction(notificationId);
    try {
      await apiClient.post(`/servers/${serverId}/notifications/${notificationId}/acknowledge`);
      setActionError('');
      await fetchModuleData({ silent: true });
    } catch (err) {
      setActionError(formatApiError(err, 'Could not acknowledge the notification.'));
    } finally {
      setNotificationAction(null);
    }
  }, [fetchModuleData, serverId]);

  const clearNotification = useCallback(async (notification) => {
    // Clearing a provisioning follow-up also clears the server's provisioning
    // warnings and marks it ready, so say so before doing it.
    if (notification.notification_type === 'provisioning.followup' && !(await confirm({
      title: 'Clear provisioning follow-up?',
      description: 'This also clears the server\'s provisioning warnings and marks its readiness as ready. Only do this once the follow-up items are handled.',
      confirmLabel: 'Clear',
    }))) {
      return;
    }
    setNotificationAction(notification.id);
    try {
      await apiClient.post(`/servers/${serverId}/notifications/${notification.id}/clear`);
      setActionError('');
      await fetchModuleData({ silent: true });
    } catch (err) {
      setActionError(formatApiError(err, 'Could not clear the notification.'));
    } finally {
      setNotificationAction(null);
    }
  }, [confirm, fetchModuleData, serverId]);

  return (
    <div className="space-y-6">
      {confirmDialog}
      {/* Title and purpose come from the shared module header above. */}
      <div className="flex flex-wrap items-center justify-end gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex min-h-11 items-center gap-2 rounded border border-zinc-800 bg-mil-bg-deep/40 px-3 py-1.5 text-xs text-mil-muted sm:min-h-0">
            <span>Show cleared</span>
            <Switch checked={showCleared} onCheckedChange={setShowCleared} className="h-4 w-7" />
          </label>
        </div>
      </div>

      {loadError || actionError ? (
        <div role="alert" className="flex items-center gap-2 rounded border border-red-600/30 bg-red-600/10 px-3 py-2 text-xs text-red-300">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 flex-1">{loadError || actionError}</span>
          {loadError ? (
            <button type="button" onClick={() => fetchModuleData()} className="min-h-11 px-2 hover:text-red-100 sm:min-h-0">Try again</button>
          ) : null}
        </div>
      ) : null}

      {loading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-5 w-5 animate-spin text-brand" />
        </div>
      ) : (
        <>
          <Card className="border-zinc-800 bg-mil-bg-deep/60">
            <CardContent className="p-4">
              <div className="mb-4 flex items-center gap-2 text-xs font-semibold tracking-[0.06em] text-mil-dim">
                <ClipboardList className="h-4 w-4 text-brand" />
                ACTIVE SERVER NOTIFICATIONS
              </div>

              {notifications.length === 0 && !loadError ? (
                <div className="flex flex-col items-center justify-center py-10 text-center">
                  <CheckCircle2 className="mb-2 h-8 w-8 text-green-500/60" />
                  <p className="text-sm text-mil-muted">No actionable server notifications.</p>
                  <p className="mt-1 text-xs text-mil-dim">
                    When provisioning or runtime checks need attention, they will appear here.
                  </p>
                </div>
              ) : (
                <div className="space-y-3">
                  {notifications.map((notification) => {
                    const severityClass = SEVERITY_STYLES[notification.severity] || SEVERITY_STYLES.warning;
                    const isBusy = notificationAction === notification.id;
                    return (
                      <Card key={notification.id} className={`border ${severityClass}`}>
                        <CardContent className="p-4">
                          <div className="flex flex-wrap items-start justify-between gap-3">
                            <div className="space-y-2">
                              <div className="flex flex-wrap items-center gap-2">
                                <span className="text-sm font-semibold text-white">{notification.title}</span>
                                <Badge variant="outline" className="border-white/10 text-[11px] text-mil-fg capitalize">
                                  {notification.severity}
                                </Badge>
                                {notification.acknowledged && (
                                  <Badge variant="outline" className="border-green-600/30 text-[11px] text-green-300">
                                    Acknowledged
                                  </Badge>
                                )}
                                {notification.status === 'cleared' && (
                                  <Badge variant="outline" className="border-zinc-700 text-[11px] text-mil-muted">
                                    Cleared
                                  </Badge>
                                )}
                              </div>

                              {notification.message && (
                                <p className="text-sm text-mil-muted">{notification.message}</p>
                              )}

                              {Array.isArray(notification.checklist) && notification.checklist.length > 0 && (
                                <div className="space-y-1 rounded border border-zinc-800/80 bg-mil-bg-deep/40 p-3">
                                  <div className="text-xs font-medium text-mil-muted">
                                    Follow-Up Checklist
                                  </div>
                                  {notification.checklist.map((item, index) => (
                                    <div key={`${notification.id}-${index}`} className="text-xs text-mil-muted">
                                      <span className="font-medium text-mil-muted">{item.stage || 'check'}:</span> {item.message}
                                    </div>
                                  ))}
                                </div>
                              )}

                              <div className="flex flex-wrap items-center gap-3 text-[11px] text-mil-dim">
                                <span>{notification.source || 'system'}</span>
                                {notification.created_at && <span>{parseServerDate(notification.created_at)?.toLocaleString()}</span>}
                                {notification.acknowledged_at && (
                                  <span>Ack: {parseServerDate(notification.acknowledged_at)?.toLocaleString()}</span>
                                )}
                              </div>
                            </div>

                            <div className="flex items-center gap-2">
                              {notification.status !== 'cleared' && (
                                <>
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    disabled={isBusy || notification.acknowledged}
                                    onClick={() => acknowledgeNotification(notification.id)}
                                    className="h-11 border-zinc-800 text-xs text-mil-muted sm:h-8"
                                  >
                                    {isBusy ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : null}
                                    Acknowledge
                                  </Button>
                                  <Button
                                    size="sm"
                                    onClick={() => clearNotification(notification)}
                                    disabled={isBusy}
                                    className="h-11 bg-brand text-xs text-black hover:bg-brand-light sm:h-8"
                                  >
                                    {isBusy ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : null}
                                    Clear
                                  </Button>
                                </>
                              )}
                            </div>
                          </div>
                        </CardContent>
                      </Card>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>

          <Card className="border-zinc-800 bg-mil-bg-deep/60">
            <CardContent className="flex items-start gap-3 p-4 text-xs text-mil-muted">
              <Bell className="mt-0.5 h-4 w-4 shrink-0 text-brand" />
              <p>
                Server-down alerts can also go to Discord or any HTTPS webhook: add one under Servers &rarr; Integrations.
              </p>
            </CardContent>
          </Card>
        </>
      )}

    </div>
  );
}

export default NotificationsModule;
