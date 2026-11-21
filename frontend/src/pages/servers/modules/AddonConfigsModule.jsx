import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useOutletContext } from 'react-router';
import {
  AlertTriangle,
  Braces,
  Eye,
  EyeOff,
  FileJson,
  Loader2,
  RefreshCw,
  Save,
  Search,
  SlidersHorizontal,
} from 'lucide-react';
import apiClient from '@/lib/apiClient';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/hooks/use-toast';
import { applyJsonEdits, flattenForForm } from './addons/jsonTextPatch';
import { formatApiError } from '@/utils/errorMessages';
import useConfirmDialog from '@/hooks/useConfirmDialog';

/**
 * Addon configs, in one place.
 *
 * Every Reforger addon keeps its own JSON under the server's profile tree, so
 * changing one setting meant hunting for the file in the file manager. The
 * profile tree holds ~175 .json files of which ~20 are settings; the rest are
 * per-player kits, radio state and saved map drawings, so the list defaults to
 * the settings the backend classified and hides the rest behind a toggle.
 *
 * Form mode reads the shape of the file itself — no per-addon schema — so a
 * boolean becomes a switch and a number becomes a number field. Saving splices
 * the changed values back into the original text so untouched bytes, including
 * float literals like `60.0`, survive exactly.
 */

// Keys whose values are credentials. Masked until revealed so a shared screen
// does not leak a webhook. The file manager already exposes these to the same
// role, so this is shoulder-surfing defence, not an access control.
const SECRET_KEY_PATTERN = /(secret|token|password|webhook|api[_-]?key|auth)/i;

// Keys addon authors use for inline documentation rather than configuration.
const COMMENT_KEY_PATTERN = /(^|\.)(_comment|_instructions|_note|_readme|_help)\w*$/i;

function labelFor(path) {
  const leaf = path.split('.').pop();
  return leaf
    .replace(/^m_[a-z]?/, '')       // Enfusion's m_bEnabled / m_fMinFOV prefixes
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .trim();
}

function groupOf(path) {
  const parts = path.split('.');
  return parts.length > 1 ? parts.slice(0, -1).join('.') : '';
}

function SecretValue({ value, onChange, disabled }) {
  const [revealed, setRevealed] = useState(false);
  return (
    <div className="flex items-center gap-1">
      <Input
        type={revealed ? 'text' : 'password'}
        value={value ?? ''}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled}
        className="h-7 border-zinc-700 bg-mil-bg-deep/70 text-xs text-white"
      />
      <Button
        size="icon" variant="ghost" type="button"
        onClick={() => setRevealed((prev) => !prev)}
        className="h-7 w-7 shrink-0 text-mil-dim hover:text-brand"
        aria-label={revealed ? 'Hide value' : 'Reveal value'}
      >
        {revealed ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
      </Button>
    </div>
  );
}

// Array/object values are edited as JSON text. The textarea used to be bound to
// JSON.stringify(value) and ignore text that did not parse, so every keystroke
// that briefly broke the JSON was undone. Keep the text locally and commit it
// once it parses.
function JsonValueEditor({ value, onChange, disabled }) {
  const [text, setText] = useState(() => JSON.stringify(value, null, 2));
  const [invalid, setInvalid] = useState(false);
  return (
    <div className="space-y-1">
      <Textarea
        value={text}
        onChange={(event) => {
          const next = event.target.value;
          setText(next);
          try {
            onChange(JSON.parse(next));
            setInvalid(false);
          } catch {
            setInvalid(true);
          }
        }}
        aria-invalid={invalid}
        disabled={disabled}
        rows={3}
        className="border-zinc-700 bg-mil-bg-deep/70 font-mono text-[11px] text-white"
      />
      {invalid ? <p className="text-[11px] text-amber-300">Not valid JSON yet; the last valid value is kept.</p> : null}
    </div>
  );
}

function FieldRow({ entry, onChange, disabled }) {
  const { path, value, isArray } = entry;

  if (COMMENT_KEY_PATTERN.test(path)) {
    return (
      <p className="col-span-2 border-l-2 border-zinc-700 pl-2 text-[11px] italic text-mil-dim">
        {String(value)}
      </p>
    );
  }

  let control;
  if (typeof value === 'boolean') {
    control = (
      <Switch
        checked={value}
        onCheckedChange={(next) => onChange(path, next)}
        disabled={disabled}
        className="h-5 w-9"
      />
    );
  } else if (isArray || (value !== null && typeof value === 'object')) {
    control = (
      <JsonValueEditor value={value} onChange={(next) => onChange(path, next)} disabled={disabled} />
    );
  } else if (typeof value === 'number') {
    control = (
      <Input
        type="number"
        step="any"
        value={value}
        onChange={(event) => {
          const next = event.target.value;
          if (next === '') return;
          const parsed = Number(next);
          if (!Number.isNaN(parsed)) onChange(path, parsed);
        }}
        disabled={disabled}
        className="h-7 border-zinc-700 bg-mil-bg-deep/70 text-xs text-white"
      />
    );
  } else if (SECRET_KEY_PATTERN.test(path)) {
    control = <SecretValue value={value} onChange={(next) => onChange(path, next)} disabled={disabled} />;
  } else {
    control = (
      <Input
        value={value ?? ''}
        onChange={(event) => onChange(path, event.target.value)}
        disabled={disabled}
        className="h-7 border-zinc-700 bg-mil-bg-deep/70 text-xs text-white"
      />
    );
  }

  return (
    <>
      <label className="self-center text-[11px] capitalize text-mil-fg" title={path}>
        {labelFor(path)}
      </label>
      <div className="min-w-0">{control}</div>
    </>
  );
}

function AddonConfigsModule() {
  const { server, serverId, canManage, user } = useOutletContext();

  const [entries, setEntries] = useState([]);
  const [counts, setCounts] = useState({});
  const [showAll, setShowAll] = useState(false);
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState('');
  const [search, setSearch] = useState('');

  const [selected, setSelected] = useState(null);
  const [originalText, setOriginalText] = useState('');
  const [rawText, setRawText] = useState('');
  const [parsed, setParsed] = useState(null);
  const [parseError, setParseError] = useState('');
  const [edits, setEdits] = useState({});
  const [mode, setMode] = useState('form');
  const [fileLoading, setFileLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const { confirm, dialog: confirmDialog } = useConfirmDialog();
  // Latest open request and dirty flag, read from async callbacks.
  const openRequestRef = useRef(0);
  const dirtyRef = useRef(false);

  const fetchList = useCallback(async () => {
    setListLoading(true);
    setListError('');
    try {
      const res = await apiClient.get(`/servers/${serverId}/addon-configs`, {
        params: { include: showAll ? 'all' : 'settings' },
      });
      setEntries(res.data?.entries || []);
      setCounts(res.data?.counts || {});
    } catch (error) {
      setEntries([]);
      setListError(
        formatApiError(error, 'Could not read the profile directory for this server.'),
      );
    } finally {
      setListLoading(false);
    }
  }, [serverId, showAll]);

  useEffect(() => { fetchList(); }, [fetchList]);

  const visible = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return entries;
    const terms = query.split(/\s+/);
    return entries.filter((entry) => {
      const text = `${entry.addon} ${entry.name} ${entry.path}`.toLowerCase();
      return terms.every((term) => text.includes(term));
    });
  }, [entries, search]);

  const grouped = useMemo(() => {
    const map = new Map();
    for (const entry of visible) {
      if (!map.has(entry.addon)) map.set(entry.addon, []);
      map.get(entry.addon).push(entry);
    }
    return [...map.entries()];
  }, [visible]);

  const openFile = useCallback(async (entry) => {
    if (dirtyRef.current && !(await confirm({
      title: 'Discard unsaved changes?',
      description: 'Opening another config discards the edits to the current one.',
      destructive: true,
      confirmLabel: 'Discard changes',
    }))) {
      return;
    }
    const requestId = openRequestRef.current + 1;
    openRequestRef.current = requestId;
    setSelected(entry);
    setFileLoading(true);
    setEdits({});
    setParseError('');
    try {
      const res = await apiClient.get(`/servers/${serverId}/files/read`, {
        params: { root: 'profile', path: entry.path },
      });
      // A slower read for a previously clicked file must not fill this
      // editor: saving would write that file's text to this path.
      if (openRequestRef.current !== requestId) return;
      const content = res.data?.content ?? '';
      setOriginalText(content);
      setRawText(content);
      try {
        setParsed(JSON.parse(content));
        setParseError('');
      } catch (err) {
        setParsed(null);
        setParseError(err.message);
        setMode('raw');
      }
    } catch (error) {
      if (openRequestRef.current !== requestId) return;
      toast({
        title: 'Could not open that config',
        description: formatApiError(error, entry.path),
      });
      setSelected(null);
    } finally {
      if (openRequestRef.current === requestId) setFileLoading(false);
    }
  }, [confirm, serverId]);

  const handleFieldChange = useCallback((path, value) => {
    setEdits((prev) => ({ ...prev, [path]: value }));
  }, []);

  const formEntries = useMemo(() => {
    if (!parsed) return [];
    return flattenForForm(parsed).map((entry) => (
      Object.prototype.hasOwnProperty.call(edits, entry.path)
        ? { ...entry, value: edits[entry.path] }
        : entry
    ));
  }, [parsed, edits]);

  const dirty = mode === 'raw' ? rawText !== originalText : Object.keys(edits).length > 0;
  dirtyRef.current = dirty;

  const handleSave = useCallback(async () => {
    if (!selected) return;

    let content;
    if (mode === 'raw') {
      try {
        JSON.parse(rawText);
      } catch (err) {
        toast({ title: 'Not valid JSON', description: err.message });
        return;
      }
      content = rawText;
    } else {
      const pending = Object.entries(edits).map(([path, value]) => ({ path, value }));
      const { text, missing } = applyJsonEdits(originalText, pending);
      if (missing.length > 0) {
        // Falling back silently would drop the operator's change; re-serialize
        // the whole document instead and say that the formatting will shift.
        const merged = JSON.parse(originalText);
        for (const { path, value } of pending) {
          const parts = path.split('.');
          let cursor = merged;
          for (const part of parts.slice(0, -1)) cursor = cursor[part];
          cursor[parts[parts.length - 1]] = value;
        }
        content = JSON.stringify(merged, null, 2);
        toast({
          title: 'Rewrote the whole file',
          description: `Could not locate ${missing.length} value(s) in the original text, so formatting may change.`,
        });
      } else {
        content = text;
      }
    }

    setSaving(true);
    try {
      await apiClient.put(
        `/servers/${serverId}/files/write`,
        { content },
        {
          params: { root: 'profile', path: selected.path },
          validateStatus: (s) => s < 400,
        },
      );

      setOriginalText(content);
      setRawText(content);
      setEdits({});
      try { setParsed(JSON.parse(content)); } catch { /* raw mode already flagged it */ }
      toast({ title: 'Config saved', description: selected.path });
      fetchList();
    } catch (error) {
      toast({
        title: 'Save failed',
        description: formatApiError(error, 'Could not write that config.'),
      });
    } finally {
      setSaving(false);
    }
  }, [edits, fetchList, mode, originalText, rawText, selected, server?.name, serverId, user]);

  return (
    <div className="grid gap-4 xl:grid-cols-[320px_minmax(0,1fr)]">
      {confirmDialog}
      <Card className="border-zinc-800 bg-mil-bg-deep/60">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-sm tracking-[0.06em] text-mil-fg">
            <FileJson className="h-4 w-4 text-brand" /> ADDON CONFIGS
          </CardTitle>
          <p className="text-xs text-mil-dim">
            Every addon&apos;s JSON settings file under this server&apos;s profile directory.
          </p>
        </CardHeader>
        <CardContent className="space-y-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-mil-dim" />
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search addons and files"
              aria-label="Search addon configs"
              className="h-8 border-zinc-700 bg-mil-bg-deep/70 pl-8 text-xs text-white placeholder:text-mil-dim"
            />
          </div>

          <div className="flex items-center justify-between gap-2 pb-1">
            <label className="flex items-center gap-2 text-[11px] text-mil-muted">
              <Switch checked={showAll} onCheckedChange={setShowAll} className="h-4 w-8" />
              Show data files
            </label>
            <Button
              size="icon" variant="ghost" onClick={fetchList} disabled={listLoading}
              className="h-7 w-7 text-mil-dim hover:text-brand" aria-label="Refresh list"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${listLoading ? 'animate-spin' : ''}`} />
            </Button>
          </div>

          {!showAll && counts.data > 0 && (
            <p className="text-[11px] text-mil-dim">
              Hiding {counts.data} player/state file{counts.data === 1 ? '' : 's'}
              {counts.backup > 0 && ` and ${counts.backup} backup${counts.backup === 1 ? '' : 's'}`}.
            </p>
          )}

          {listError && (
            <div className="flex items-start gap-2 rounded border border-amber-600/30 bg-amber-950/20 p-2 text-[11px] text-amber-200">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              {listError}
            </div>
          )}

          <div className="max-h-[60vh] space-y-3 overflow-y-auto pr-1">
            {listLoading && entries.length === 0 ? (
              <div className="flex justify-center py-8">
                <Loader2 className="h-5 w-5 animate-spin text-brand" />
              </div>
            ) : grouped.length === 0 ? (
              <p className="py-8 text-center text-xs text-mil-dim">
                {search.trim() ? `Nothing matches “${search.trim()}”.` : 'No addon configs found.'}
              </p>
            ) : grouped.map(([addon, files]) => (
              <div key={addon}>
                <p className="mb-1 text-xs text-mil-dim font-medium capitalize">{addon}</p>
                <div className="space-y-0.5">
                  {files.map((entry) => (
                    <button
                      key={entry.path}
                      type="button"
                      onClick={() => openFile(entry)}
                      className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[11px] transition-colors ${
                        selected?.path === entry.path
                          ? 'bg-brand/10 text-brand'
                          : 'text-mil-fg hover:bg-zinc-900'
                      }`}
                    >
                      <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                      {entry.kind !== 'settings' && (
                        <Badge variant="outline" className="shrink-0 border-zinc-700 text-[11px] text-mil-dim capitalize">
                          {entry.kind}
                        </Badge>
                      )}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card className="border-zinc-800 bg-mil-bg-deep/60">
        {!selected ? (
          <CardContent className="flex flex-col items-center justify-center py-20 text-center text-mil-dim">
            <SlidersHorizontal className="mb-3 h-8 w-8" />
            <p className="text-sm">Pick a config on the left to edit it.</p>
            <p className="mt-1 text-xs">
              Switches, numbers and text fields are generated from the file itself.
            </p>
          </CardContent>
        ) : (
          <>
            <CardHeader className="pb-3">
              <div className="flex flex-wrap items-center gap-2">
                <CardTitle className="text-sm tracking-[0.06em] text-mil-fg">
                  {selected.name}
                </CardTitle>
                {dirty && (
                  <Badge variant="outline" className="border-amber-600/40 text-[11px] text-amber-300">
                    Unsaved
                  </Badge>
                )}
                <div className="ml-auto flex items-center gap-1">
                  <Button
                    size="sm"
                    variant={mode === 'form' ? 'default' : 'outline'}
                    onClick={() => setMode('form')}
                    disabled={!parsed}
                    className={`h-7 text-[11px] ${mode === 'form' ? 'bg-brand text-black hover:bg-brand-light' : 'border-zinc-700 text-mil-muted'}`}
                  >
                    <SlidersHorizontal className="mr-1 h-3 w-3" /> Form
                  </Button>
                  <Button
                    size="sm"
                    variant={mode === 'raw' ? 'default' : 'outline'}
                    onClick={() => setMode('raw')}
                    className={`h-7 text-[11px] ${mode === 'raw' ? 'bg-brand text-black hover:bg-brand-light' : 'border-zinc-700 text-mil-muted'}`}
                  >
                    <Braces className="mr-1 h-3 w-3" /> Raw JSON
                  </Button>
                </div>
              </div>
              <p className="font-mono text-[11px] text-mil-dim">profile/{selected.path}</p>
            </CardHeader>

            <CardContent className="space-y-3">
              {fileLoading ? (
                <div className="flex justify-center py-12">
                  <Loader2 className="h-6 w-6 animate-spin text-brand" />
                </div>
              ) : (
                <>
                  {parseError && (
                    <div className="flex items-start gap-2 rounded border border-red-600/30 bg-red-950/20 p-2 text-[11px] text-red-200">
                      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                      This file is not valid JSON, so only raw editing is available: {parseError}
                    </div>
                  )}

                  {mode === 'form' && parsed ? (
                    <div className="max-h-[58vh] space-y-4 overflow-y-auto pr-1">
                      {(() => {
                        const groups = new Map();
                        for (const entry of formEntries) {
                          const key = groupOf(entry.path);
                          if (!groups.has(key)) groups.set(key, []);
                          groups.get(key).push(entry);
                        }
                        return [...groups.entries()].map(([group, groupEntries]) => (
                          <div key={group || '_root'}>
                            {group && (
                              <p className="mb-1.5 border-b border-zinc-800 pb-1 text-[11px] text-brand/70 capitalize">
                                {group.replace(/\./g, ' › ')}
                              </p>
                            )}
                            <div className="grid grid-cols-[minmax(8rem,1fr)_minmax(0,1.4fr)] items-start gap-x-3 gap-y-1.5">
                              {groupEntries.map((entry) => (
                                <FieldRow
                                  key={`${selected?.path || ''}::${entry.path}`}
                                  entry={entry}
                                  onChange={handleFieldChange}
                                  disabled={!canManage || saving}
                                />
                              ))}
                            </div>
                          </div>
                        ));
                      })()}
                    </div>
                  ) : (
                    <Textarea
                      value={rawText}
                      onChange={(event) => setRawText(event.target.value)}
                      disabled={!canManage || saving}
                      rows={24}
                      spellCheck={false}
                      className="border-zinc-700 bg-zinc-950/70 font-mono text-[11px] text-white"
                    />
                  )}

                  <div className="flex flex-wrap items-center justify-end gap-2 border-t border-zinc-800 pt-3">
                    {mode === 'form' && dirty && (
                      <span className="mr-auto text-[11px] text-mil-dim">
                        {Object.keys(edits).length} value{Object.keys(edits).length === 1 ? '' : 's'} changed —
                        the rest of the file is written back byte-for-byte.
                      </span>
                    )}
                    <Button
                      size="sm" variant="outline"
                      onClick={() => openFile(selected)}
                      disabled={saving || !dirty}
                      className="h-8 border-zinc-700 text-[11px] text-mil-muted hover:border-brand/40 hover:text-brand"
                    >
                      Discard changes
                    </Button>
                    <Button
                      size="sm"
                      onClick={handleSave}
                      disabled={!canManage || saving || !dirty}
                      className="h-8 bg-brand text-[11px] text-black hover:bg-brand-light"
                    >
                      {saving ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Save className="mr-1 h-3.5 w-3.5" />}
                      Save config
                    </Button>
                  </div>
                </>
              )}
            </CardContent>
          </>
        )}
      </Card>
    </div>
  );
}

export default AddonConfigsModule;
