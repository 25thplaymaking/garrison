import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useOutletContext } from 'react-router';
import apiClient from '@/lib/apiClient';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import {
  AlertTriangle,
  Clock,
  Loader2,
  RefreshCw,
  Send,
  StickyNote,
  User,
} from 'lucide-react';
import { formatApiError } from '@/utils/errorMessages';
import { CommandEmptyState, CommandLoadingState } from '@/components/tactical/CommandUI';

const NOTE_CATEGORIES = [
  { value: 'general', label: 'General' },
  { value: 'mod_change', label: 'Mod Change' },
  { value: 'mod_request', label: 'Mod Request' },
  { value: 'moderation', label: 'Moderation' },
  { value: 'development', label: 'Development' },
  { value: 'community', label: 'Community' },
  { value: 'incident', label: 'Incident' },
  { value: 'test', label: 'Test' },
  { value: 'handoff', label: 'Handoff' },
];

const NOTE_STATUSES = [
  { value: 'open', label: 'Open' },
  { value: 'in_progress', label: 'In Progress' },
  { value: 'blocked', label: 'Blocked' },
  { value: 'resolved', label: 'Resolved' },
  { value: 'archived', label: 'Archived' },
];

const NOTE_PRIORITIES = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'critical', label: 'Critical' },
];

function emptyNoteForm() {
  return {
    title: '',
    category: 'general',
    status: 'open',
    priority: 'medium',
    tagsText: '',
    relatedModsText: '',
    requestedActionsText: '',
    followUpRequired: false,
    eventAt: '',
    content: '',
  };
}

function parseTokenList(value) {
  return String(value || '')
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseLineList(value) {
  return String(value || '')
    .split('\n')
    .map((item) => item.trim())
    .filter(Boolean);
}

function humanize(value) {
  if (!value) return 'Unspecified';
  return String(value)
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function formatDate(value) {
  if (!value) return 'Unknown';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Unknown' : date.toLocaleString();
}

function statusTone(status) {
  return {
    open: 'border-red-600/30 text-red-300',
    in_progress: 'border-blue-600/30 text-blue-300',
    blocked: 'border-amber-600/30 text-amber-300',
    resolved: 'border-green-600/30 text-green-300',
    archived: 'border-zinc-700 text-zinc-400',
  }[status] || 'border-zinc-700 text-zinc-300';
}

function priorityTone(priority) {
  return {
    low: 'border-zinc-700 text-zinc-300',
    medium: 'border-blue-600/30 text-blue-300',
    high: 'border-amber-600/30 text-amber-300',
    critical: 'border-red-600/30 text-red-300',
  }[priority] || 'border-zinc-700 text-zinc-300';
}

// The retired Tasks tab kept checklist items in this browser's localStorage
// only, so an "assignee" never saw them. Surface whatever is left so it can be
// logged as a shared note instead of silently disappearing.
const LEGACY_TASKS_PREFIX = 'server_todos_';

function readLegacyTasks(serverId) {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(`${LEGACY_TASKS_PREFIX}${serverId}`) || '[]');
    return Array.isArray(parsed) ? parsed.filter((task) => task && String(task.text || '').trim()) : [];
  } catch {
    return [];
  }
}

function writeLegacyTasks(serverId, tasks) {
  try {
    if (tasks.length) {
      window.localStorage.setItem(`${LEGACY_TASKS_PREFIX}${serverId}`, JSON.stringify(tasks));
    } else {
      window.localStorage.removeItem(`${LEGACY_TASKS_PREFIX}${serverId}`);
    }
  } catch {
    // Storage blocked: the list just stays as it was.
  }
}

function NotesModule() {
  const { serverId, user } = useOutletContext();
  const [notes, setNotes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [form, setForm] = useState(emptyNoteForm);
  const [legacyTasks, setLegacyTasks] = useState(() => readLegacyTasks(serverId));

  useEffect(() => {
    setLegacyTasks(readLegacyTasks(serverId));
  }, [serverId]);

  const dropLegacyTask = useCallback((taskId) => {
    setLegacyTasks((current) => {
      const next = taskId === undefined ? [] : current.filter((task) => task.id !== taskId);
      writeLegacyTasks(serverId, next);
      return next;
    });
  }, [serverId]);

  const copyLegacyTask = useCallback((task) => {
    const text = String(task.text || '').trim();
    setForm({
      ...emptyNoteForm(),
      title: text.slice(0, 200),
      content: task.assignee ? `${text}\n\nAssigned to: ${task.assignee}` : text,
      status: task.done ? 'resolved' : 'open',
      followUpRequired: !task.done,
    });
    dropLegacyTask(task.id);
    setMessage('Task copied into the note form below. Log it to share it with the team.');
  }, [dropLegacyTask]);

  const fetchNotes = useCallback(async (silent = false) => {
    if (silent) setRefreshing(true);
    else setLoading(true);

    try {
      const res = await apiClient.get(`/servers/${serverId}/notes`);
      setNotes(Array.isArray(res.data?.notes) ? res.data.notes : Array.isArray(res.data) ? res.data : []);
      setError('');
    } catch (err) {
      setError(formatApiError(err, 'Failed to load notes.'));
      if (!silent) setNotes([]);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [serverId]);

  useEffect(() => {
    fetchNotes();
  }, [fetchNotes]);

  useEffect(() => {
    const intervalId = setInterval(() => {
      fetchNotes(true);
    }, 30_000);
    return () => clearInterval(intervalId);
  }, [fetchNotes]);

  const addNote = useCallback(async () => {
    if (!form.content.trim()) return;
    setSubmitting(true);
    setError('');
    setMessage('');
    try {
      const notePayload = {
        title: form.title.trim(),
        category: form.category,
        status: form.status,
        priority: form.priority,
        tags: parseTokenList(form.tagsText),
        related_mods: parseTokenList(form.relatedModsText),
        requested_actions: parseLineList(form.requestedActionsText),
        follow_up_required: form.followUpRequired,
        event_at: form.eventAt ? new Date(form.eventAt).toISOString() : null,
        content: form.content.trim(),
      };
      await apiClient.post(`/servers/${serverId}/notes`, notePayload, {
        validateStatus: (s) => s < 400,
      });
      setForm(emptyNoteForm());
      setMessage('Note logged.');
      await fetchNotes(true);
    } catch (err) {
      setError(formatApiError(err, 'Failed to save note.'));
    } finally {
      setSubmitting(false);
    }
  }, [fetchNotes, form, serverId, user]);

  const openNotes = useMemo(
    () => notes.filter((note) => !['resolved', 'archived'].includes(note.status || 'open')).length,
    [notes],
  );
  const followUps = useMemo(() => notes.filter((note) => note.follow_up_required).length, [notes]);
  const modRelated = useMemo(
    () => notes.filter((note) => ['mod_change', 'mod_request'].includes(note.category || 'general')).length,
    [notes],
  );

  return (
    <div className="space-y-6">
      {/* Title and purpose come from the shared module header above. */}
      <div className="flex flex-wrap items-center justify-end gap-3">
        <div className="flex flex-wrap gap-2">
          <Badge variant="outline" className="border-zinc-800 text-[11px] text-mil-muted">
            Refreshes every 30s
          </Badge>
          <Button size="sm" variant="outline" onClick={() => fetchNotes(true)} className="h-7 border-zinc-800 text-xs text-mil-muted">
            <RefreshCw className={`mr-1 h-3 w-3 ${refreshing ? 'animate-spin' : ''}`} /> Refresh
          </Button>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <Card className="border-zinc-800 bg-mil-bg-deep/60">
          <CardContent className="p-4">
            <div className="text-xs text-mil-muted font-medium">Total Notes</div>
            <div className="mt-2 text-2xl font-semibold text-white">{notes.length}</div>
            <div className="mt-1 text-xs text-mil-dim">Shared operating history for this server.</div>
          </CardContent>
        </Card>
        <Card className="border-zinc-800 bg-mil-bg-deep/60">
          <CardContent className="p-4">
            <div className="text-xs text-mil-muted font-medium">Open Queue</div>
            <div className="mt-2 text-2xl font-semibold text-white">{openNotes}</div>
            <div className="mt-1 text-xs text-mil-dim">{followUps} require explicit follow-up.</div>
          </CardContent>
        </Card>
        <Card className="border-zinc-800 bg-mil-bg-deep/60">
          <CardContent className="p-4">
            <div className="text-xs text-mil-muted font-medium">Mod Related</div>
            <div className="mt-2 text-2xl font-semibold text-white">{modRelated}</div>
            <div className="mt-1 text-xs text-mil-dim">Requests and changes tied to mods or workshop content.</div>
          </CardContent>
        </Card>
      </div>

      {legacyTasks.length > 0 ? (
        <Card className="border-amber-600/30 bg-amber-600/[0.04]">
          <CardHeader className="pb-2">
            <CardTitle className="text-xs font-semibold tracking-wider text-amber-300">
              {legacyTasks.length} TASK{legacyTasks.length === 1 ? '' : 'S'} SAVED ONLY IN THIS BROWSER
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-xs text-mil-muted">
              The old Tasks tab stored its checklist on this device, so nobody else could see it. Copy a task into a note to
              share it with the other operators, or drop it.
            </p>
            <ul className="space-y-2">
              {legacyTasks.map((task) => (
                <li key={task.id} className="flex flex-wrap items-center gap-2 border border-zinc-800 bg-mil-bg-deep/60 px-3 py-2">
                  <span className={`min-w-0 flex-1 wrap-break-word text-sm ${task.done ? 'text-mil-dim line-through' : 'text-mil-fg'}`}>
                    {task.text}
                    {task.assignee ? <span className="ml-2 text-xs text-mil-dim">({task.assignee})</span> : null}
                  </span>
                  <Button size="sm" variant="outline" onClick={() => copyLegacyTask(task)}
                    className="h-11 border-zinc-800 text-xs text-mil-muted sm:h-7">
                    Copy to note
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => dropLegacyTask(task.id)}
                    className="h-11 border-zinc-800 text-xs text-mil-dim sm:h-7">
                    Drop
                  </Button>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}

      {message ? (
        <div className="rounded border border-green-600/30 bg-green-600/10 px-3 py-2 text-xs text-green-300">
          {message}
        </div>
      ) : null}

      {error ? (
        <div className="rounded border border-red-600/30 bg-red-600/10 px-3 py-2 text-xs text-red-400">
          {error}
        </div>
      ) : null}

      <Card className="border-zinc-800 bg-mil-bg-deep/60">
        <CardHeader className="pb-2">
          <CardTitle className="text-xs font-semibold tracking-wider text-mil-muted">NEW OPS NOTE</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 xl:grid-cols-2">
            <div>
              <label className="text-xs text-mil-muted">Title</label>
              <Input
                value={form.title}
                onChange={(e) => setForm((prev) => ({ ...prev, title: e.target.value }))}
                placeholder="Short summary for the queue"
                className="mt-1 border-zinc-800 bg-mil-bg-deep/60 text-sm text-white"
              />
            </div>
            <div>
              <label className="text-xs text-mil-muted">Event Time</label>
              <Input
                type="datetime-local"
                value={form.eventAt}
                onChange={(e) => setForm((prev) => ({ ...prev, eventAt: e.target.value }))}
                className="mt-1 border-zinc-800 bg-mil-bg-deep/60 text-sm text-white"
              />
            </div>
          </div>

          <div className="grid gap-3 xl:grid-cols-3">
            <div>
              <label className="text-xs text-mil-muted">Category</label>
              <select
                value={form.category}
                onChange={(e) => setForm((prev) => ({ ...prev, category: e.target.value }))}
                className="mt-1 h-9 w-full rounded border border-zinc-800 bg-mil-bg-deep/60 px-3 text-sm text-white"
              >
                {NOTE_CATEGORIES.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-xs text-mil-muted">Status</label>
              <select
                value={form.status}
                onChange={(e) => setForm((prev) => ({ ...prev, status: e.target.value }))}
                className="mt-1 h-9 w-full rounded border border-zinc-800 bg-mil-bg-deep/60 px-3 text-sm text-white"
              >
                {NOTE_STATUSES.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-xs text-mil-muted">Priority</label>
              <select
                value={form.priority}
                onChange={(e) => setForm((prev) => ({ ...prev, priority: e.target.value }))}
                className="mt-1 h-9 w-full rounded border border-zinc-800 bg-mil-bg-deep/60 px-3 text-sm text-white"
              >
                {NOTE_PRIORITIES.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </div>
          </div>

          <div className="flex items-center justify-between rounded-lg border border-zinc-800 bg-mil-bg-deep/40 px-4 py-3">
            <div>
              <div className="text-sm text-mil-muted">Follow-up required</div>
              <div className="text-[11px] text-mil-dim">Use this for unresolved tasks, moderation review, or changes that still need testing.</div>
            </div>
            <Switch checked={form.followUpRequired} onCheckedChange={(value) => setForm((prev) => ({ ...prev, followUpRequired: value }))} className="h-4 w-7" />
          </div>

          <div className="grid gap-3 xl:grid-cols-2">
            <div>
              <label className="text-xs text-mil-muted">Tags</label>
              <Input
                value={form.tagsText}
                onChange={(e) => setForm((prev) => ({ ...prev, tagsText: e.target.value }))}
                placeholder="Comma separated, e.g. battleye, restart-window, handoff"
                className="mt-1 border-zinc-800 bg-mil-bg-deep/60 text-sm text-white"
              />
            </div>
            <div>
              <label className="text-xs text-mil-muted">Related Mods</label>
              <Input
                value={form.relatedModsText}
                onChange={(e) => setForm((prev) => ({ ...prev, relatedModsText: e.target.value }))}
                placeholder="Comma separated mod names"
                className="mt-1 border-zinc-800 bg-mil-bg-deep/60 text-sm text-white"
              />
            </div>
          </div>

          <div>
            <label className="text-xs text-mil-muted">Requested Actions</label>
            <Textarea
              value={form.requestedActionsText}
              onChange={(e) => setForm((prev) => ({ ...prev, requestedActionsText: e.target.value }))}
              placeholder="One action per line, e.g. test updated mod pack on staging"
              className="mt-1 min-h-[88px] border-zinc-800 bg-mil-bg-deep/60 text-sm text-white placeholder:text-mil-dim"
            />
          </div>

          <div>
            <label className="text-xs text-mil-muted">Details</label>
            <Textarea
              value={form.content}
              onChange={(e) => setForm((prev) => ({ ...prev, content: e.target.value }))}
              placeholder="Capture the decision, evidence, impact, and what the next admin should know."
              className="mt-1 min-h-[140px] border-zinc-800 bg-mil-bg-deep/60 text-sm text-white placeholder:text-mil-dim"
              rows={5}
            />
          </div>

          <div className="flex justify-end">
            <Button size="sm" onClick={addNote} disabled={!form.content.trim() || submitting}
              className="bg-brand text-black hover:bg-brand-light text-xs">
              {submitting ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <Send className="mr-1 h-3 w-3" />}
              Log Note
            </Button>
          </div>
        </CardContent>
      </Card>

      {loading ? (
        <CommandLoadingState immersive={false} label="Loading notes" rows={3} />
      ) : notes.length === 0 ? (
        <CommandEmptyState
          icon={StickyNote}
          title="No notes yet"
          description="Start logging operational context for mod changes, moderation, testing, and handoffs."
        />
      ) : (
        <div className="space-y-3">
          {notes.map((note, index) => (
            <Card key={note.id || index} className="border-zinc-800 bg-mil-bg-deep/60">
              <CardContent className="space-y-3 p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium text-mil-fg">{note.title || humanize(note.category)}</span>
                      <Badge variant="outline" className="border-zinc-700 text-[11px] text-mil-muted">
                        {humanize(note.category)}
                      </Badge>
                      <Badge variant="outline" className={`text-[11px] ${statusTone(note.status)}`}>
                        {humanize(note.status)}
                      </Badge>
                      <Badge variant="outline" className={`text-[11px] ${priorityTone(note.priority)}`}>
                        {humanize(note.priority)}
                      </Badge>
                      {note.follow_up_required ? (
                        <Badge variant="outline" className="border-brand/30 text-[11px] text-brand">
                          Follow-up
                        </Badge>
                      ) : null}
                    </div>
                    <p className="mt-3 whitespace-pre-wrap text-sm text-mil-fg">{note.content}</p>
                  </div>
                </div>

                {(note.tags?.length || note.related_mods?.length) ? (
                  <div className="flex flex-wrap gap-2">
                    {(note.tags || []).map((tag) => (
                      <Badge key={`${note.id}-tag-${tag}`} variant="outline" className="border-zinc-700 text-[11px] text-mil-muted">
                        #{tag}
                      </Badge>
                    ))}
                    {(note.related_mods || []).map((mod) => (
                      <Badge key={`${note.id}-mod-${mod}`} variant="outline" className="border-blue-600/30 text-[11px] text-blue-300">
                        {mod}
                      </Badge>
                    ))}
                  </div>
                ) : null}

                {note.requested_actions?.length > 0 ? (
                  <div className="rounded-lg border border-zinc-800/70 bg-zinc-950/60 p-3">
                    <div className="mb-2 text-xs font-medium text-mil-muted">
                      Requested Actions
                    </div>
                    <div className="space-y-1">
                      {note.requested_actions.map((action, actionIndex) => (
                        <div key={`${note.id}-action-${actionIndex}`} className="text-xs text-mil-muted">
                          {action}
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}

                <div className="flex flex-wrap gap-4 text-[11px] text-mil-dim">
                  <span className="flex items-center gap-1">
                    <User className="h-3 w-3" /> {note.author_name || note.author_id || 'Unknown'}
                  </span>
                  <span className="flex items-center gap-1">
                    <Clock className="h-3 w-3" /> Created {formatDate(note.created_at)}
                  </span>
                  {note.event_at ? (
                    <span className="flex items-center gap-1">
                      <AlertTriangle className="h-3 w-3" /> Event {formatDate(note.event_at)}
                    </span>
                  ) : null}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

export default NotesModule;
