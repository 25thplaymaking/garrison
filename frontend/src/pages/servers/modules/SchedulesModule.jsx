import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useOutletContext } from 'react-router';
import apiClient from '@/lib/apiClient';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { useUnsavedChanges } from '@/context/UnsavedChangesContext';
import { formatApiError } from '@/utils/errorMessages';
import { parseServerDate } from '@/utils/serverStatus';
import useConfirmDialog from '@/hooks/useConfirmDialog';
import {
  CalendarClock,
  Loader2,
  Plus,
  RefreshCw,
  Save,
  Trash2,
} from 'lucide-react';

const EMPTY_FORM = {
  action_type: 'restart',
  schedule: '0 4 * * *',
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
  downtime_minutes: 60,
  enabled: true,
};

// The executor resolves zones with IANA names; free text silently fell back
// to UTC before the API started rejecting it. Suggest the zones the unit uses.
const TIMEZONE_SUGGESTIONS = ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'Europe/London', 'UTC'];

function actionLabel(actionType) {
  return String(actionType || 'restart').replace(/_/g, ' ');
}

function buildSchedulePayload(schedule) {
  const actionType = schedule.action_type || 'restart';
  return {
    action_type: actionType,
    schedule: schedule.schedule || '',
    timezone: schedule.timezone || 'UTC',
    enabled: schedule.enabled !== false,
    downtime_minutes: actionType === 'downtime_window' ? Number(schedule.downtime_minutes || 0) : null,
  };
}

function schedulePayloadKey(schedule) {
  return JSON.stringify(buildSchedulePayload(schedule));
}

function SchedulesModule() {
  const { serverId, user, server } = useOutletContext();
  const { registerDirtySource } = useUnsavedChanges();
  const [schedules, setSchedules] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  // Create/update/delete used try/finally only, so a 400 (bad cron, missing
  // downtime minutes) or a failed load left the operator with no message.
  const [error, setError] = useState('');
  const { confirm, dialog: confirmDialog } = useConfirmDialog();
  const savedSchedulesRef = useRef([]);

  const fetchSchedules = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiClient.get(`/servers/${serverId}/schedules`);
      const nextSchedules = Array.isArray(res.data) ? res.data : [];
      savedSchedulesRef.current = nextSchedules;
      setSchedules(nextSchedules);
    } catch (err) {
      setError(formatApiError(err, 'Failed to load schedules.'));
    } finally {
      setLoading(false);
    }
  }, [serverId]);

  useEffect(() => {
    fetchSchedules();
  }, [fetchSchedules]);

  const createSchedule = useCallback(async () => {
    setSaving(true);
    try {
      const payload = buildSchedulePayload(form);
      await apiClient.post(`/servers/${serverId}/schedules`, payload, {
        validateStatus: (s) => s < 400,
      });
      setError('');
      setForm(EMPTY_FORM);
      await fetchSchedules();
    } catch (err) {
      setError(formatApiError(err, 'Failed to create schedule.'));
    } finally {
      setSaving(false);
    }
  }, [fetchSchedules, form, server?.name, serverId, user]);

  const updateSchedule = useCallback(async (schedule) => {
    try {
      await apiClient.put(`/servers/${serverId}/schedules/${schedule.id}`, buildSchedulePayload(schedule), {
        validateStatus: (s) => s < 400,
      });
      setError('');
      await fetchSchedules();
    } catch (err) {
      setError(formatApiError(err, 'Failed to update schedule.'));
    }
  }, [fetchSchedules, server?.name, serverId, user]);

  const deleteSchedule = useCallback(async (scheduleId) => {
    const schedule = schedules.find((item) => item.id === scheduleId) || {};
    if (!(await confirm({
      title: 'Delete Schedule',
      description: `Delete the ${actionLabel(schedule.action_type)} schedule "${schedule.schedule || ''}" (${schedule.timezone || 'UTC'})?`,
      destructive: true,
      confirmLabel: 'Delete',
    }))) {
      return;
    }
    try {
      await apiClient.delete(`/servers/${serverId}/schedules/${scheduleId}`, {
        validateStatus: (s) => s < 400,
      });
      setError('');
      await fetchSchedules();
    } catch (err) {
      setError(formatApiError(err, 'Failed to delete schedule.'));
    }
  }, [confirm, fetchSchedules, schedules, server?.name, serverId, user]);

  const formDirty = useMemo(
    () => schedulePayloadKey(form) !== schedulePayloadKey(EMPTY_FORM),
    [form],
  );

  const changedSchedules = useMemo(() => {
    const savedById = new Map(
      savedSchedulesRef.current
        .filter((schedule) => schedule.id)
        .map((schedule) => [schedule.id, schedulePayloadKey(schedule)]),
    );
    return schedules.filter((schedule) => (
      schedule.id
      && savedById.has(schedule.id)
      && savedById.get(schedule.id) !== schedulePayloadKey(schedule)
    ));
  }, [schedules]);

  const saveScheduleDrafts = useCallback(async () => {
    setSaving(true);
    try {
      if (formDirty) {
        await apiClient.post(`/servers/${serverId}/schedules`, buildSchedulePayload(form));
        setForm(EMPTY_FORM);
      }
      for (const schedule of changedSchedules) {
        await apiClient.put(`/servers/${serverId}/schedules/${schedule.id}`, buildSchedulePayload(schedule));
      }
      await fetchSchedules();
      setError('');
      return true;
    } catch (err) {
      setError(formatApiError(err, 'Failed to save schedules.'));
      return false;
    } finally {
      setSaving(false);
    }
  }, [changedSchedules, fetchSchedules, form, formDirty, serverId]);

  const discardScheduleDrafts = useCallback(() => {
    setForm(EMPTY_FORM);
    setSchedules(savedSchedulesRef.current);
  }, []);

  useEffect(() => registerDirtySource({
    id: 'server-schedules',
    label: 'Schedules',
    summary: [
      formDirty ? '1 new schedule' : '',
      changedSchedules.length ? `${changedSchedules.length} edited schedule${changedSchedules.length === 1 ? '' : 's'}` : '',
    ].filter(Boolean).join(', ') || 'Schedule changes pending',
    dirty: formDirty || changedSchedules.length > 0,
    onSave: saveScheduleDrafts,
    onDiscard: discardScheduleDrafts,
    onSaved: async () => {
      setForm(EMPTY_FORM);
      await fetchSchedules();
    },
  }), [
    changedSchedules.length,
    discardScheduleDrafts,
    fetchSchedules,
    formDirty,
    registerDirtySource,
    saveScheduleDrafts,
    server?.name,
    serverId,
  ]);

  const actionHelp = useMemo(() => ({
    restart: 'Restart the server when the schedule triggers.',
    start: 'Start the server when the schedule triggers.',
    stop: 'Stop the server when the schedule triggers.',
    downtime_window: 'Stop the server at the start time, then auto-start it again after the downtime duration.',
  }), []);

  return (
    <div className="space-y-6">
      {confirmDialog}
      <datalist id="schedule-timezones">
        {TIMEZONE_SUGGESTIONS.map((zone) => <option key={zone} value={zone} />)}
      </datalist>
      {/* Title and purpose come from the shared module header above. */}
      <div className="flex items-center justify-end">
        <Button size="sm" variant="outline" onClick={fetchSchedules} className="h-11 border-zinc-800 text-xs text-mil-muted sm:h-7">
          <RefreshCw className="mr-1 h-3 w-3" /> Refresh
        </Button>
      </div>

      {error ? (
        <div role="alert" className="rounded border border-red-600/30 bg-red-600/10 px-3 py-2 text-xs text-red-300">
          {error}
        </div>
      ) : null}

      <Card className="border-zinc-800 bg-mil-bg-deep/60">
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-xs font-semibold tracking-wider text-mil-muted">
            <Plus className="h-3.5 w-3.5 text-brand" /> NEW SCHEDULE
          </CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 lg:grid-cols-2">
          <label className="space-y-1 text-xs text-mil-dim">
            <span>Action</span>
            <select
              value={form.action_type}
              onChange={(e) => setForm((prev) => ({ ...prev, action_type: e.target.value }))}
              className="h-9 w-full rounded-md border border-zinc-800 bg-mil-bg-deep/60 px-3 text-xs text-white"
            >
              <option value="restart">Restart</option>
              <option value="start">Start</option>
              <option value="stop">Stop</option>
              <option value="downtime_window">Downtime Window</option>
            </select>
          </label>

          <label className="space-y-1 text-xs text-mil-dim">
            <span>Cron Schedule</span>
            <Input
              value={form.schedule}
              onChange={(e) => setForm((prev) => ({ ...prev, schedule: e.target.value }))}
              placeholder="0 4 * * *"
              className="h-9 border-zinc-800 bg-mil-bg-deep/60 text-xs text-white"
            />
            <span className="block text-[11px] text-[#6b6b6b]">minute hour day month weekday - 0 4 * * * is 04:00 daily, 0 4 * * 1 is Mondays.</span>
          </label>

          <label className="space-y-1 text-xs text-mil-dim">
            <span>Timezone</span>
            <Input
              value={form.timezone}
              list="schedule-timezones"
              onChange={(e) => setForm((prev) => ({ ...prev, timezone: e.target.value }))}
              className="h-9 border-zinc-800 bg-mil-bg-deep/60 text-xs text-white"
            />
          </label>

          {form.action_type === 'downtime_window' && (
            <label className="space-y-1 text-xs text-mil-dim">
              <span>Downtime Minutes</span>
              <Input
                type="number"
                value={form.downtime_minutes}
                onChange={(e) => setForm((prev) => ({ ...prev, downtime_minutes: e.target.value }))}
                className="h-9 border-zinc-800 bg-mil-bg-deep/60 text-xs text-white"
              />
            </label>
          )}

          <div className="lg:col-span-2 rounded border border-zinc-800/70 bg-mil-bg-deep/40 px-3 py-2 text-xs text-mil-dim">
            {actionHelp[form.action_type]}
          </div>

          <div className="flex items-center gap-2 text-xs text-mil-dim">
            <Switch checked={form.enabled} onCheckedChange={(value) => setForm((prev) => ({ ...prev, enabled: value }))} className="h-4 w-7" />
            Enabled
          </div>

          <div className="flex justify-end">
            <Button size="sm" onClick={createSchedule} disabled={saving} className="bg-brand text-black hover:bg-brand-light">
              {saving ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <Save className="mr-1 h-3 w-3" />}
              Create
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card className="border-zinc-800 bg-mil-bg-deep/60">
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-xs font-semibold tracking-wider text-mil-muted">
            <CalendarClock className="h-3.5 w-3.5 text-brand" /> ACTIVE SCHEDULES
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-6 w-6 animate-spin text-brand" />
            </div>
          ) : schedules.length === 0 ? (
            <p className="text-xs text-mil-dim">No schedules have been created for this server yet.</p>
          ) : (
            schedules.map((schedule) => (
              <div key={schedule.id} className="rounded border border-zinc-800/70 bg-mil-bg-deep/40 p-3">
                <div className="grid gap-3 lg:grid-cols-5">
                  <select
                    aria-label="Action"
                    value={schedule.action_type}
                    onChange={(e) => setSchedules((prev) => prev.map((item) => item.id === schedule.id ? { ...item, action_type: e.target.value } : item))}
                    className="h-9 rounded-md border border-zinc-800 bg-mil-bg-deep/60 px-3 text-xs text-white"
                  >
                    <option value="restart">Restart</option>
                    <option value="start">Start</option>
                    <option value="stop">Stop</option>
                    <option value="downtime_window">Downtime Window</option>
                  </select>
                  <Input
                    aria-label="Cron schedule"
                    value={schedule.schedule || ''}
                    onChange={(e) => setSchedules((prev) => prev.map((item) => item.id === schedule.id ? { ...item, schedule: e.target.value } : item))}
                    className="h-9 border-zinc-800 bg-mil-bg-deep/60 text-xs text-white"
                  />
                  <Input
                    aria-label="Timezone"
                    list="schedule-timezones"
                    value={schedule.timezone || ''}
                    onChange={(e) => setSchedules((prev) => prev.map((item) => item.id === schedule.id ? { ...item, timezone: e.target.value } : item))}
                    className="h-9 border-zinc-800 bg-mil-bg-deep/60 text-xs text-white"
                  />
                  <Input
                    aria-label="Downtime minutes"
                    type="number"
                    value={schedule.downtime_minutes || ''}
                    disabled={schedule.action_type !== 'downtime_window'}
                    onChange={(e) => setSchedules((prev) => prev.map((item) => item.id === schedule.id ? { ...item, downtime_minutes: e.target.value } : item))}
                    className="h-9 border-zinc-800 bg-mil-bg-deep/60 text-xs text-white"
                  />
                  <div className="flex items-center justify-end gap-2">
                    <Switch
                      aria-label="Enabled"
                      checked={schedule.enabled !== false}
                      onCheckedChange={(value) => setSchedules((prev) => prev.map((item) => item.id === schedule.id ? { ...item, enabled: value } : item))}
                      className="h-4 w-7"
                    />
                    <Button size="sm" variant="outline" onClick={() => updateSchedule(schedule)} className="h-11 border-zinc-800 text-xs text-mil-muted sm:h-8">
                      Save
                    </Button>
                    <Button aria-label="Delete schedule" size="sm" variant="ghost" onClick={() => deleteSchedule(schedule.id)} className="h-11 text-red-400 hover:text-red-300 sm:h-8">
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
                <div className="mt-2 flex flex-wrap gap-4 text-[11px] text-mil-dim">
                  <span className={!schedule.next_run && schedule.enabled !== false ? 'text-amber-300' : undefined}>
                    Next run: {schedule.next_run
                      ? parseServerDate(schedule.next_run)?.toLocaleString()
                      : schedule.enabled === false ? 'disabled' : 'never - the cron or timezone is not valid'}
                  </span>
                  <span>Last run: {schedule.last_run ? parseServerDate(schedule.last_run)?.toLocaleString() : '-'}</span>
                  <span>Last result: {schedule.last_result?.message || '-'}</span>
                </div>
              </div>
            ))
          )}
        </CardContent>
      </Card>
    </div>
  );
}

export default SchedulesModule;
