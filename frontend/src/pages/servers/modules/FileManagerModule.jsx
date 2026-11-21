import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useOutletContext } from 'react-router';

import apiClient from '@/lib/apiClient';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { toast } from '@/hooks/use-toast';
import { useUnsavedChanges } from '@/context/UnsavedChangesContext';
import useConfirmDialog from '@/hooks/useConfirmDialog';
import {
  chooseFileManagerRoot,
  formatFileManagerPath,
  getDiscardMessage,
  shouldConfirmDiscard,
} from './fileManagerUtils';
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle,
  ChevronRight,
  Download,
  Edit3,
  Eye,
  File,
  FileArchive,
  FileText,
  Folder,
  FolderOpen,
  HardDrive,
  Loader2,
  Plus,
  RefreshCw,
  Save,
  Search,
  ShieldCheck,
  Sparkles,
  Trash2,
} from 'lucide-react';
import { formatApiError } from '@/utils/errorMessages';

// Read-only files (large logs) open on their newest part and page backwards on request.
// Putting a whole multi-MB log into the page froze it for seconds and kept scrolling janky.
const LOG_VIEW_CHUNK_BYTES = 512 * 1024;
const LOG_VIEW_MAX_BYTES = 4 * 1024 * 1024;

function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const idx = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** idx).toFixed(idx === 0 ? 0 : 1)} ${units[idx]}`;
}

function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function fileIcon(entry) {
  if (entry.is_dir) return <Folder className="h-4 w-4 text-brand" />;
  const ext = (entry.name || '').split('.').pop()?.toLowerCase();
  if (['json', 'xml', 'cfg', 'ini', 'yaml', 'yml', 'toml', 'conf', 'properties'].includes(ext)) {
    return <FileText className="h-4 w-4 text-blue-400" />;
  }
  if (['log', 'txt'].includes(ext)) {
    return <FileText className="h-4 w-4 text-zinc-400" />;
  }
  return <File className="h-4 w-4 text-zinc-500" />;
}

const ROOT_LABELS = { config: 'Configs', profile: 'Profile', workshop: 'Workshop' };
const ROOT_ICONS = {
  config: <HardDrive className="h-3.5 w-3.5" />,
  profile: <FolderOpen className="h-3.5 w-3.5" />,
  workshop: <Folder className="h-3.5 w-3.5" />,
};
const NEW_FILE_EXTENSION_OPTIONS = [
  { value: '.json', label: 'JSON (.json)' },
  { value: '.yaml', label: 'YAML (.yaml)' },
  { value: '.yml', label: 'YAML (.yml)' },
  { value: '.toml', label: 'TOML (.toml)' },
  { value: '.xml', label: 'XML (.xml)' },
  { value: '.cfg', label: 'CFG (.cfg)' },
  { value: '.conf', label: 'CONF (.conf)' },
  { value: '.ini', label: 'INI (.ini)' },
  { value: '.properties', label: 'Properties (.properties)' },
  { value: '.md', label: 'Markdown (.md)' },
  { value: '.txt', label: 'Text (.txt)' },
  { value: '.log', label: 'Log (.log)' },
  { value: '.csv', label: 'CSV (.csv)' },
  { value: '.py', label: 'Python (.py)' },
  { value: '.sh', label: 'Shell (.sh)' },
  { value: '.lua', label: 'Lua (.lua)' },
];

function buildDraftPath(currentPath, baseName, extension) {
  const trimmedName = String(baseName || '').trim();
  const finalName = trimmedName.toLowerCase().endsWith(extension.toLowerCase())
    ? trimmedName
    : `${trimmedName}${extension}`;
  return currentPath ? `${currentPath}/${finalName}` : finalName;
}

function editorStatusToneClasses(tone) {
  if (tone === 'success') {
    return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300';
  }
  if (tone === 'error') {
    return 'border-red-500/30 bg-red-500/10 text-red-300';
  }
  return 'border-brand/20 bg-brand/10 text-mil-fg';
}

function countLines(value) {
  if (!value) return 1;
  return value.split(/\r?\n/).length;
}

function changedLineCount(before, after) {
  const beforeLines = String(before || '').split(/\r?\n/);
  const afterLines = String(after || '').split(/\r?\n/);
  const maxLines = Math.max(beforeLines.length, afterLines.length);
  let changed = 0;

  for (let index = 0; index < maxLines; index += 1) {
    if ((beforeLines[index] || '') !== (afterLines[index] || '')) {
      changed += 1;
    }
  }

  return changed;
}

function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename || 'download';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function filenameFromDisposition(headers, fallback) {
  const cd = (headers && (headers['content-disposition'] || headers['Content-Disposition'])) || '';
  const match = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(cd);
  return match ? decodeURIComponent(match[1].trim()) : fallback;
}

async function readBlobError(err, fallback) {
  const data = err?.response?.data;
  if (data instanceof Blob) {
    try {
      const parsed = JSON.parse(await data.text());
      return parsed?.detail || fallback;
    } catch {
      return fallback;
    }
  }
  return data?.detail || fallback;
}

function FileManagerModule() {
  const { serverId, user } = useOutletContext();
  const { registerDirtySource } = useUnsavedChanges();
  const { confirm, dialog } = useConfirmDialog();

  // Root state
  const [roots, setRoots] = useState([]);
  const [rootsLoading, setRootsLoading] = useState(true);

  // Browsing state
  const [activeRoot, setActiveRoot] = useState('config');
  const [currentPath, setCurrentPath] = useState('');
  const [entries, setEntries] = useState([]);
  const [browsing, setBrowsing] = useState(false);
  const [browseError, setBrowseError] = useState(null);
  const [filter, setFilter] = useState('');

  // Selection + deletion state
  const [selected, setSelected] = useState(() => new Set());
  const [deleteTargets, setDeleteTargets] = useState([]); // [{ name, path, is_dir }]
  const [deleting, setDeleting] = useState(false);

  // Download state — tracks the path currently being fetched as a blob.
  const [downloadingPath, setDownloadingPath] = useState(null);

  // Editor state
  const [editFile, setEditFile] = useState(null); // { root, path, name, content, modified }
  const [editContent, setEditContent] = useState('');
  const [editDirty, setEditDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [validating, setValidating] = useState(false);
  const [assisting, setAssisting] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const [readError, setReadError] = useState(null);
  const [reading, setReading] = useState(false);
  const [editorStatus, setEditorStatus] = useState(null);
  const [aiSuggestion, setAiSuggestion] = useState(null);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const logViewRef = useRef(null);
  // How to place the log view's scroll after its text changes: at the end, or kept in place.
  const logScrollRef = useRef(null);
  const editFileKeyRef = useRef(null);

  // Active tab: 'browser' or 'profile'
  const [activeTab, setActiveTab] = useState('browser');
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [createError, setCreateError] = useState('');
  const [newFileName, setNewFileName] = useState('');
  const [newFileExtension, setNewFileExtension] = useState('.json');

  const [rootsError, setRootsError] = useState('');
  const hasBrowsedRef = useRef(false);

  // Fetch available roots. A refresh keeps the page mounted: swapping the
  // whole module for a spinner closed the open editor and lost the folder.
  const fetchRoots = useCallback(async ({ silent = false } = {}) => {
    if (!silent) setRootsLoading(true);
    try {
      const res = await apiClient.get(`/servers/${serverId}/files/roots`);
      setRoots(Array.isArray(res.data) ? res.data : []);
      setRootsError('');
    } catch (err) {
      setRootsError(formatApiError(err, 'Could not list this server\'s file roots.'));
      if (!silent) setRoots([]);
    } finally {
      if (!silent) setRootsLoading(false);
    }
  }, [serverId]);

  useEffect(() => {
    fetchRoots();
  }, [fetchRoots]);

  useEffect(() => {
    const handleBeforeUnload = (event) => {
      if (!editDirty) return;
      event.preventDefault();
      event.returnValue = '';
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [editDirty]);

  // Browse a directory
  const browse = useCallback(async (root, path) => {
    setBrowsing(true);
    setBrowseError(null);
    setSelected(new Set());
    try {
      const res = await apiClient.get(`/servers/${serverId}/files/browse`, {
        params: { root, path: path || '' },
      });
      setActiveRoot(root);
      setCurrentPath(path || '');
      setEntries(res.data?.entries || []);
    } catch (err) {
      setBrowseError(formatApiError(err, 'Failed to browse directory'));
      setEntries([]);
    } finally {
      setBrowsing(false);
    }
  }, [serverId]);

  const resetEditor = useCallback(() => {
    setEditFile(null);
    setEditContent('');
    setEditDirty(false);
    setSaveError(null);
    setReadError(null);
    setEditorStatus(null);
    setAiSuggestion(null);
  }, []);

  const resetCreateDialog = useCallback(() => {
    setCreateDialogOpen(false);
    setCreateError('');
    setNewFileName('');
    setNewFileExtension('.json');
  }, []);

  const confirmDiscardChanges = useCallback(async (action, nextFile = null) => {
    if (!shouldConfirmDiscard(editDirty, editFile, nextFile)) return true;
    return confirm({
      title: 'Discard unsaved changes?',
      description: getDiscardMessage(editFile?.name || 'this file', action),
      confirmLabel: 'Discard changes',
      destructive: true,
    });
  }, [confirm, editDirty, editFile]);

  const browseWithGuard = useCallback(async (root, path, action) => {
    if (!(await confirmDiscardChanges(action))) return;
    resetEditor();
    await browse(root, path);
  }, [browse, confirmDiscardChanges, resetEditor]);

  // Initial browse when roots load; a later roots refresh keeps the current
  // folder unless its root has gone away.
  useEffect(() => {
    const initialRoot = chooseFileManagerRoot(roots, activeTab, activeRoot);
    if (!initialRoot) return;
    const currentRootStillExists = roots.some((root) => root?.exists && root.key === activeRoot);
    if (hasBrowsedRef.current && currentRootStillExists) return;
    hasBrowsedRef.current = true;
    browse(initialRoot.key, '');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roots]);

  // Navigate into a directory
  const navigateInto = useCallback((entry) => {
    if (entry.is_dir) {
      browseWithGuard(activeRoot, entry.path, `open ${entry.name}`);
    }
  }, [activeRoot, browseWithGuard]);

  // Navigate up
  const navigateUp = useCallback(() => {
    if (!currentPath) return;
    const parts = currentPath.split('/').filter(Boolean);
    parts.pop();
    browseWithGuard(activeRoot, parts.join('/'), 'leave the current file');
  }, [activeRoot, currentPath, browseWithGuard]);

  // Open a file for editing
  const openFile = useCallback(async (entry) => {
    if (entry.is_dir) return;
    const nextFile = { root: activeRoot, path: entry.path };
    if (editFile?.root === nextFile.root && editFile?.path === nextFile.path) return;
    if (!(await confirmDiscardChanges(`open ${entry.name}`, nextFile))) return;
    resetEditor();
    setReading(true);
    setReadError(null);
    try {
      // Files over the 1 MB edit cap (large logs) open read-only on their newest part.
      const viewOnly = entry.editable === false;
      const res = await apiClient.get(`/servers/${serverId}/files/read`, {
        params: viewOnly
          ? { root: activeRoot, path: entry.path, tail_bytes: LOG_VIEW_CHUNK_BYTES }
          : { root: activeRoot, path: entry.path },
      });
      setEditFile({
        root: activeRoot,
        path: entry.path,
        name: res.data.name,
        modified: res.data.modified,
        isNew: false,
        readOnly: res.data.editable === false,
        viewOffset: res.data.offset ?? 0,
        size: res.data.size,
      });
      logScrollRef.current = { mode: 'end' };
      setEditContent(res.data.content || '');
      setEditDirty(false);
      setSaveError(null);
      setEditorStatus(null);
      setAiSuggestion(null);
    } catch (err) {
      setReadError(formatApiError(err, 'Failed to read file'));
    } finally {
      setReading(false);
    }
  }, [activeRoot, confirmDiscardChanges, editFile, resetEditor, serverId]);

  editFileKeyRef.current = editFile ? `${editFile.root}:${editFile.path}` : null;

  // Prepend the previous window of a read-only log, keeping the reader's place.
  const loadEarlier = useCallback(async () => {
    if (!editFile?.readOnly || !editFile.viewOffset || loadingEarlier) return;
    const fileKey = `${editFile.root}:${editFile.path}`;
    setLoadingEarlier(true);
    try {
      const res = await apiClient.get(`/servers/${serverId}/files/read`, {
        params: {
          root: editFile.root,
          path: editFile.path,
          tail_bytes: LOG_VIEW_CHUNK_BYTES,
          end: editFile.viewOffset,
        },
      });
      if (editFileKeyRef.current !== fileKey) return;
      const view = logViewRef.current;
      logScrollRef.current = view ? { mode: 'keep', height: view.scrollHeight, top: view.scrollTop } : null;
      setEditContent((current) => (res.data.content || '') + current);
      setEditFile((current) => (current ? { ...current, viewOffset: res.data.offset ?? 0 } : current));
    } catch (err) {
      toast({
        title: 'Could not load earlier lines',
        description: formatApiError(err, 'Failed to read file'),
        variant: 'destructive',
      });
    } finally {
      setLoadingEarlier(false);
    }
  }, [editFile, loadingEarlier, serverId]);

  const applyLogScroll = useCallback(() => {
    const view = logViewRef.current;
    const placement = logScrollRef.current;
    if (!view || !placement) return;
    logScrollRef.current = null;
    view.scrollTop = placement.mode === 'keep'
      ? view.scrollHeight - placement.height + placement.top
      : view.scrollHeight;
  }, []);

  // The dialog mounts the log view after its text is set, so placement also runs on mount.
  const setLogView = useCallback((node) => {
    logViewRef.current = node;
    applyLogScroll();
  }, [applyLogScroll]);

  useLayoutEffect(applyLogScroll, [applyLogScroll, editContent]);

  // Download a file (or a folder as ZIP) as a blob, honoring auth headers.
  const downloadEntry = useCallback(async (entry) => {
    const isFolder = !!entry.is_dir;
    const endpoint = isFolder ? 'download-folder' : 'download';
    const fallback = isFolder
      ? `${entry.name || ROOT_LABELS[activeRoot] || activeRoot}.zip`
      : (entry.name || 'download');
    const trackKey = isFolder ? `dir:${entry.path || ''}` : entry.path;
    setDownloadingPath(trackKey);
    try {
      const res = await apiClient.get(`/servers/${serverId}/files/${endpoint}`, {
        params: { root: activeRoot, path: entry.path || '' },
        responseType: 'blob',
      });
      saveBlob(res.data, filenameFromDisposition(res.headers, fallback));
    } catch (err) {
      const detail = await readBlobError(err, 'Download failed');
      toast({ title: 'Download failed', description: detail, variant: 'destructive' });
    } finally {
      setDownloadingPath(null);
    }
  }, [activeRoot, serverId]);

  const downloadCurrentFolder = useCallback(() => {
    const name = currentPath
      ? currentPath.split('/').filter(Boolean).pop()
      : (ROOT_LABELS[activeRoot] || activeRoot);
    downloadEntry({ is_dir: true, name, path: currentPath });
  }, [activeRoot, currentPath, downloadEntry]);

  // Save file
  const saveFile = useCallback(async () => {
    if (!editFile) return;
    setSaving(true);
    setSaveError(null);
    try {
      await apiClient.put(
        `/servers/${serverId}/files/write`,
        { content: editContent },
        { params: { root: editFile.root, path: editFile.path }, validateStatus: (s) => s < 400,},
      );
      setEditDirty(false);
      setEditFile((prev) => (prev ? {
        ...prev,
        modified: new Date().toISOString(),
        isNew: false,
      } : prev));
      setEditorStatus({
        tone: 'success',
        text: `${editFile.name} saved to ${formatFileManagerPath(editFile.root, editFile.path)}.`,
      });
      toast({
        title: 'File saved',
        description: `${editFile.name} was written to ${formatFileManagerPath(editFile.root, editFile.path)}.`,
      });
      browse(activeRoot, currentPath);
    } catch (err) {
      const detail = formatApiError(err, 'Failed to save file');
      setSaveError(detail);
      setEditorStatus({ tone: 'error', text: detail });
    } finally {
      setSaving(false);
    }
  }, [editFile, editContent, serverId, activeRoot, currentPath, browse, user]);

  useEffect(() => {
    if (!editFile) return undefined;
    return registerDirtySource({
      id: `file-${editFile.root}-${editFile.path}`,
      label: `File: ${editFile.name}`,
      summary: formatFileManagerPath(editFile.root, editFile.path),
      dirty: editDirty || Boolean(editFile.isNew),
      onSave: saveFile,
      onDiscard: resetEditor,
      onSaved: () => {
        setEditDirty(false);
        setEditFile((prev) => (prev ? { ...prev, isNew: false, modified: new Date().toISOString() } : prev));
      },
    });
  }, [editDirty, editFile, registerDirtySource, resetEditor, saveFile, serverId]);

  const validateFile = useCallback(async () => {
    if (!editFile) return;
    // The formatted text belongs to this file; if the editor moved on while
    // the request ran, applying it would put file A's content in B's draft.
    const fileKey = `${editFile.root}:${editFile.path}`;
    setValidating(true);
    setSaveError(null);
    try {
      const res = await apiClient.post(
        `/servers/${serverId}/files/validate`,
        { content: editContent },
        { params: { root: editFile.root, path: editFile.path } },
      );
      if (editFileKeyRef.current !== fileKey) return;
      const nextContent = typeof res.data?.formatted_content === 'string'
        ? res.data.formatted_content
        : editContent;
      const contentChanged = nextContent !== editContent;
      if (contentChanged) {
        setEditContent(nextContent);
        setEditDirty(true);
      }
      setAiSuggestion(null);

      const issues = Array.isArray(res.data?.issues) ? res.data.issues.filter(Boolean) : [];
      const statusTone = res.data?.valid ? 'success' : (res.data?.supported ? 'error' : 'info');
      const statusText = [res.data?.summary, ...issues.slice(0, 2)].filter(Boolean).join(' ');
      setEditorStatus({ tone: statusTone, text: statusText || 'Validation finished.' });
      toast({
        title: res.data?.valid ? 'Validation complete' : (res.data?.supported ? 'Validation found issues' : 'Validation unavailable'),
        description: statusText || 'Validation finished.',
      });
    } catch (err) {
      const detail = formatApiError(err, 'Validation failed.');
      setEditorStatus({ tone: 'error', text: detail });
      toast({ title: 'Validation failed', description: detail });
    } finally {
      setValidating(false);
    }
  }, [editContent, editFile, serverId]);

  const runAiAssist = useCallback(async () => {
    if (!editFile) return;
    const fileKey = `${editFile.root}:${editFile.path}`;
    setAssisting(true);
    setSaveError(null);
    try {
      const res = await apiClient.post(
        `/servers/${serverId}/files/ai-assist`,
        { content: editContent },
        { params: { root: editFile.root, path: editFile.path } },
      );
      // AI assist is slow; drop a suggestion for a file that is no longer open.
      if (editFileKeyRef.current !== fileKey) return;
      const nextContent = typeof res.data?.corrected_content === 'string'
        ? res.data.corrected_content
        : editContent;
      const changed = nextContent !== editContent;
      const issues = Array.isArray(res.data?.issues) ? res.data.issues.filter(Boolean) : [];
      const statusText = [res.data?.summary, ...issues.slice(0, 2)].filter(Boolean).join(' ')
        || 'AI assist finished reviewing the file.';
      if (changed) {
        setAiSuggestion({
          originalContent: editContent,
          correctedContent: nextContent,
          summary: res.data?.summary || 'AI prepared a suggested fix.',
          issues,
          model: res.data?.model || 'OpenAI',
        });
      } else {
        setAiSuggestion(null);
      }
      setEditorStatus({
        tone: changed ? 'info' : 'success',
        text: changed ? `${statusText} Preview the suggestion before applying it.` : statusText,
      });
      toast({
        title: changed ? 'AI preview ready' : 'AI review complete',
        description: statusText,
      });
    } catch (err) {
      const detail = formatApiError(err, 'AI assist failed.');
      setAiSuggestion(null);
      setEditorStatus({ tone: 'error', text: detail });
      toast({ title: 'AI assist failed', description: detail });
    } finally {
      setAssisting(false);
    }
  }, [editContent, editFile, serverId]);

  const applyAiSuggestion = useCallback(() => {
    if (!aiSuggestion) return;
    setEditContent(aiSuggestion.correctedContent);
    setEditDirty(true);
    setAiSuggestion(null);
    setEditorStatus({
      tone: 'success',
      text: 'AI suggestion applied to the draft. Review it and save when ready.',
    });
    toast({
      title: 'Suggestion applied',
      description: 'The AI preview has been copied into the draft editor.',
    });
  }, [aiSuggestion]);

  const discardAiSuggestion = useCallback(() => {
    if (!aiSuggestion) return;
    setAiSuggestion(null);
    setEditorStatus({
      tone: 'info',
      text: 'AI preview discarded. Your draft was left unchanged.',
    });
    toast({
      title: 'Suggestion discarded',
      description: 'The draft stayed exactly as it was before AI assist ran.',
    });
  }, [aiSuggestion]);

  // Close editor
  const closeEditor = useCallback(async () => {
    if (!(await confirmDiscardChanges('close the editor'))) return;
    resetEditor();
  }, [confirmDiscardChanges, resetEditor]);

  const openCreateDialog = useCallback(async () => {
    if (!(await confirmDiscardChanges('start a new file draft'))) return;
    resetEditor();
    setCreateError('');
    setCreateDialogOpen(true);
  }, [confirmDiscardChanges, resetEditor]);

  const createFileDraft = useCallback(() => {
    const trimmedName = newFileName.trim();
    if (!trimmedName) {
      setCreateError('Enter a file name before opening the draft.');
      return;
    }
    if (/[\\/]/.test(trimmedName) || trimmedName.includes('..')) {
      setCreateError('File names cannot include path separators or traversal segments.');
      return;
    }

    const draftPath = buildDraftPath(currentPath, trimmedName, newFileExtension);
    const draftName = draftPath.split('/').pop() || draftPath;
    const duplicate = entries.some((entry) => entry.name.toLowerCase() === draftName.toLowerCase());
    if (duplicate) {
      setCreateError(`${draftName} already exists in this directory.`);
      return;
    }

    setFilter('');
    setEditFile({
      root: activeRoot,
      path: draftPath,
      name: draftName,
      modified: null,
      isNew: true,
    });
    setEditContent('');
    setEditDirty(true);
    setReadError(null);
    setSaveError(null);
    setAiSuggestion(null);
    setEditorStatus({
      tone: 'info',
      text: `Draft created for ${draftName}. Save to write it to ${formatFileManagerPath(activeRoot, draftPath)}.`,
    });
    resetCreateDialog();
    toast({
      title: 'Draft opened',
      description: `${draftName} is ready in the editor. Save to create it on the server.`,
    });
  }, [activeRoot, currentPath, entries, newFileExtension, newFileName, resetCreateDialog]);

  // Breadcrumb segments
  const breadcrumbs = useMemo(() => {
    const parts = currentPath ? currentPath.split('/').filter(Boolean) : [];
    const crumbs = [{ label: ROOT_LABELS[activeRoot] || activeRoot, path: '' }];
    let running = '';
    parts.forEach((part) => {
      running = running ? `${running}/${part}` : part;
      crumbs.push({ label: part, path: running });
    });
    return crumbs;
  }, [activeRoot, currentPath]);

  // Filtered entries
  const filteredEntries = useMemo(() => {
    if (!filter.trim()) return entries;
    const q = filter.toLowerCase();
    return entries.filter((e) => e.name.toLowerCase().includes(q));
  }, [entries, filter]);

  // ── Selection + deletion ──
  const allSelected = filteredEntries.length > 0 && filteredEntries.every((e) => selected.has(e.path));
  const someSelected = selected.size > 0;

  const toggleSelect = useCallback((path) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const toggleSelectAll = useCallback(() => {
    setSelected((prev) => {
      if (filteredEntries.length > 0 && filteredEntries.every((e) => prev.has(e.path))) {
        return new Set();
      }
      return new Set(filteredEntries.map((e) => e.path));
    });
  }, [filteredEntries]);

  const requestDelete = useCallback((targetEntries) => {
    const list = (targetEntries || []).filter(Boolean);
    if (list.length === 0) return;
    setDeleteTargets(list.map((e) => ({ name: e.name, path: e.path, is_dir: e.is_dir })));
  }, []);

  const requestDeleteSelected = useCallback(() => {
    requestDelete(entries.filter((e) => selected.has(e.path)));
  }, [entries, requestDelete, selected]);

  const cancelDelete = useCallback(() => {
    if (deleting) return;
    setDeleteTargets([]);
  }, [deleting]);

  const confirmDelete = useCallback(async () => {
    if (deleteTargets.length === 0) return;
    const paths = deleteTargets.map((t) => t.path);
    setDeleting(true);
    try {
      const res = await apiClient.post(
        `/servers/${serverId}/files/delete`,
        { root: activeRoot, paths },
        { validateStatus: (s) => s < 400,},
      );
      const data = res.data || {};
      const errors = Array.isArray(data.errors) ? data.errors : [];
      // If the file open in the editor was just deleted, close the editor.
      if (editFile && paths.includes(editFile.path)) resetEditor();
      if (errors.length > 0) {
        toast({
          title: `Deleted ${data.count ?? 0} item(s), ${errors.length} failed`,
          description: errors.map((e) => `${e.path}: ${e.error}`).slice(0, 3).join(' • '),
          variant: 'destructive',
        });
      } else {
        toast({
          title: 'Files deleted',
          description: `Removed ${data.count ?? paths.length} item(s) from ${formatFileManagerPath(activeRoot, currentPath)}.`,
        });
      }
      setDeleteTargets([]);
      setSelected(new Set());
      browse(activeRoot, currentPath);
    } catch (err) {
      toast({
        title: 'Delete failed',
        description: formatApiError(err, 'Could not delete the selected items.'),
        variant: 'destructive',
      });
    } finally {
      setDeleting(false);
    }
  }, [activeRoot, browse, currentPath, deleteTargets, editFile, resetEditor, serverId, user]);

  // Switch to profile tab
  const handleTabChange = useCallback(async (tab) => {
    if (tab === activeTab) return;
    const nextRoot = chooseFileManagerRoot(roots, tab, activeRoot);
    const actionLabel = tab === 'profile'
      ? 'switch to the deployed profile view'
      : 'switch to the all files view';
    if (!(await confirmDiscardChanges(actionLabel))) return;
    setActiveTab(tab);
    resetEditor();
    if (nextRoot) {
      browse(nextRoot.key, '');
    }
  }, [activeRoot, activeTab, browse, confirmDiscardChanges, resetEditor, roots]);

  const draftPreviewPath = useMemo(
    () => buildDraftPath(currentPath, newFileName || 'new-file', newFileExtension),
    [currentPath, newFileExtension, newFileName],
  );
  const currentLineCount = useMemo(() => countLines(editContent), [editContent]);
  const currentFileExtension = useMemo(() => editFile?.name?.split('.').pop()?.toLowerCase() || '', [editFile]);
  const aiChangedLines = useMemo(
    () => (aiSuggestion ? changedLineCount(aiSuggestion.originalContent, aiSuggestion.correctedContent) : 0),
    [aiSuggestion],
  );

  if (rootsLoading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="h-6 w-6 animate-spin text-brand" />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col gap-4">
      {rootsError ? (
        <div role="alert" className="flex flex-wrap items-center gap-2 border border-red-500/30 bg-red-500/[0.06] px-3 py-2 text-xs text-red-200">
          <span className="min-w-0 flex-1 wrap-break-word">{rootsError}</span>
          <button type="button" onClick={() => fetchRoots()} className="min-h-11 px-2 text-red-100 underline-offset-2 hover:underline sm:min-h-0">
            Try again
          </button>
        </div>
      ) : null}
      <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
        <div>
          <h2 className="text-sm font-semibold tracking-wider text-mil-muted" style={{ fontFamily: "var(--font-heading)" }}>
            File Manager
          </h2>
          <p className="mt-1 text-xs text-mil-dim">
            Browse, view, download, and edit live server files. Large logs open read-only; any file (or whole folders as ZIP) can be downloaded. JSON is the primary edit workflow.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" onClick={openCreateDialog} className="h-8 border-zinc-800 text-xs text-mil-fg">
            <Plus className="mr-1 h-3.5 w-3.5" /> New file
          </Button>
          <Button size="sm" variant="outline" onClick={() => browse(activeRoot, currentPath)} className="h-8 border-zinc-800 text-xs text-mil-muted">
            <RefreshCw className="mr-1 h-3 w-3" /> Refresh
          </Button>
        </div>
      </div>

      <Tabs value={activeTab} onValueChange={handleTabChange} className="space-y-4">
        <TabsList className="grid w-full grid-cols-2 bg-mil-bg-deep/60">
          <TabsTrigger value="browser" className="text-xs">
            <HardDrive className="mr-1 h-3 w-3" /> All Files
          </TabsTrigger>
          <TabsTrigger value="profile" className="text-xs">
            <FolderOpen className="mr-1 h-3 w-3" /> Deployed Profile
          </TabsTrigger>
        </TabsList>

        <TabsContent value="browser" className="space-y-4">
          {/* Root selector */}
          <div className="flex flex-wrap gap-2">
            {roots.map((root) => (
              <button
                key={root.key}
                onClick={() => browseWithGuard(root.key, '', `switch to the ${root.label} root`)}
                disabled={!root.exists}
                className={`flex items-center gap-1.5 rounded border px-3 py-1.5 text-xs transition-colors ${
                  activeRoot === root.key && activeTab === 'browser'
                    ? 'border-brand/30 bg-brand/10 text-brand'
                    : 'border-zinc-800 bg-mil-bg-deep/40 text-mil-muted hover:border-zinc-700'
                } disabled:opacity-40`}
              >
                {ROOT_ICONS[root.key]}
                {root.label}
                {!root.exists && <span className="text-[11px] text-mil-dim">(not found)</span>}
              </button>
            ))}
          </div>

          {renderFileBrowser()}
        </TabsContent>

        <TabsContent value="profile" className="space-y-4">
          <div className="rounded border border-amber-600/20 bg-amber-600/5 px-3 py-2 text-xs text-amber-400">
            <FolderOpen className="mr-1.5 inline h-3.5 w-3.5" />
            Showing the profile directory where mods deploy their configuration files. Changes here take effect after a server restart.
          </div>

          {roots.find((r) => r.key === 'profile' && r.exists) ? (
            renderFileBrowser()
          ) : (
            <Card className="border-zinc-800 bg-mil-bg-deep/60">
              <CardContent className="py-10 text-center text-sm text-mil-dim">
                The profile directory does not exist yet. It will be created when the server starts for the first time.
              </CardContent>
            </Card>
          )}
        </TabsContent>
      </Tabs>
      {dialog}
    </div>
  );

  function renderFileBrowser() {
    return (
      <>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          {breadcrumbs.map((crumb, i) => (
            <React.Fragment key={crumb.path}>
              {i > 0 && <ChevronRight className="h-3 w-3 text-mil-dim" />}
              <button
                onClick={() => browseWithGuard(activeRoot, crumb.path, `browse ${crumb.label}`)}
                className={`rounded px-1.5 py-0.5 transition-colors ${
                  i === breadcrumbs.length - 1
                    ? 'text-brand'
                    : 'text-mil-muted hover:text-brand'
                }`}
              >
                {crumb.label}
              </button>
            </React.Fragment>
          ))}
          {browsing && <Loader2 className="ml-2 h-3 w-3 animate-spin text-brand" />}
          <Badge variant="outline" className="ml-auto border-zinc-700 text-[11px] text-mil-dim">
            {formatFileManagerPath(activeRoot, currentPath)}
          </Badge>
        </div>

        <div className="flex items-center gap-2">
          {currentPath && (
            <Button size="sm" variant="outline" onClick={navigateUp} className="h-8 border-zinc-800 text-xs text-mil-muted">
              <ArrowLeft className="mr-1 h-3 w-3" /> Up
            </Button>
          )}
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-mil-dim" />
            <Input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter files..."
              className="h-8 border-zinc-800 bg-mil-bg-deep/60 pl-9 text-xs text-white placeholder:text-mil-dim"
            />
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={downloadCurrentFolder}
            disabled={downloadingPath === `dir:${currentPath || ''}`}
            title="Download this folder as a ZIP archive"
            className="h-8 shrink-0 border-zinc-800 text-xs text-mil-muted"
          >
            {downloadingPath === `dir:${currentPath || ''}`
              ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
              : <FileArchive className="mr-1 h-3.5 w-3.5" />}
            Download folder (ZIP)
          </Button>
          {someSelected && (
            <Button
              size="sm"
              variant="outline"
              onClick={requestDeleteSelected}
              className="h-8 shrink-0 border-red-600/40 bg-red-600/10 text-xs text-red-300 hover:border-red-500/60 hover:bg-red-600/20 hover:text-red-200"
            >
              <Trash2 className="mr-1 h-3.5 w-3.5" /> Delete selected ({selected.size})
            </Button>
          )}
        </div>

        {browseError && (
          <div className="flex items-center gap-2 rounded border border-red-600/30 bg-red-600/10 px-3 py-2 text-xs text-red-400">
            <AlertTriangle className="h-3.5 w-3.5" />
            {browseError}
          </div>
        )}

        <Card className="border-zinc-800 bg-mil-bg-deep/80">
          <CardContent className="p-0">
            <div className="max-h-[62dvh] overflow-y-auto">
              {filteredEntries.length === 0 && !browsing ? (
                <div className="flex flex-col items-center justify-center py-14 text-mil-dim">
                  <Folder className="mb-2 h-8 w-8" />
                  <p className="text-sm">{filter ? 'No matching files' : 'Directory is empty'}</p>
                  <p className="mt-1 text-[11px] text-mil-dim">
                    Use New file to open a draft directly in the full editor.
                  </p>
                </div>
              ) : (
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-zinc-800/50 text-[11px] text-mil-dim">
                      <th className="w-9 px-3 py-2 text-left font-medium">
                        <Checkbox
                          checked={allSelected}
                          onCheckedChange={toggleSelectAll}
                          aria-label="Select all"
                          className="border-zinc-700 data-[state=checked]:border-brand data-[state=checked]:bg-brand data-[state=checked]:text-black"
                        />
                      </th>
                      <th className="px-3 py-2 text-left font-medium">Name</th>
                      <th className="px-3 py-2 text-right font-medium">Size</th>
                      <th className="hidden px-3 py-2 text-right font-medium sm:table-cell">Modified</th>
                      <th className="px-3 py-2 text-right font-medium">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredEntries.map((entry) => (
                      <tr
                        key={entry.path}
                        className={`border-b border-zinc-800/30 transition-colors hover:bg-zinc-900/50 ${
                          selected.has(entry.path) ? 'bg-red-500/5' : editFile?.path === entry.path ? 'bg-brand/5' : ''
                        }`}
                      >
                        <td className="px-3 py-2">
                          <Checkbox
                            checked={selected.has(entry.path)}
                            onCheckedChange={() => toggleSelect(entry.path)}
                            aria-label={`Select ${entry.name}`}
                            className="border-zinc-700 data-[state=checked]:border-brand data-[state=checked]:bg-brand data-[state=checked]:text-black"
                          />
                        </td>
                        <td className="px-3 py-2">
                          <button
                            onClick={() => {
                              if (entry.is_dir) navigateInto(entry);
                              else if (entry.viewable) openFile(entry);
                              else downloadEntry(entry);
                            }}
                            className="flex items-center gap-2 text-left text-xs text-mil-muted hover:text-white"
                          >
                            {fileIcon(entry)}
                            <span className={entry.is_dir ? 'font-medium text-brand' : ''}>
                              {entry.name}
                            </span>
                          </button>
                        </td>
                        <td className="px-3 py-2 text-right font-mono text-[11px] text-mil-dim">
                          {entry.is_dir ? '' : formatBytes(entry.size)}
                        </td>
                        <td className="hidden px-3 py-2 text-right text-[11px] text-mil-dim sm:table-cell">
                          {entry.is_dir ? '' : formatDate(entry.modified)}
                        </td>
                        <td className="px-3 py-2 text-right">
                          <div className="flex items-center justify-end gap-1">
                            {!entry.is_dir && entry.editable && (
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => openFile(entry)}
                                className="h-6 px-2 text-[11px] text-mil-muted hover:text-brand"
                              >
                                <Edit3 className="mr-1 h-3 w-3" /> Edit
                              </Button>
                            )}
                            {!entry.is_dir && entry.viewable && !entry.editable && (
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => openFile(entry)}
                                className="h-6 px-2 text-[11px] text-mil-muted hover:text-brand"
                                title="View read-only (exceeds 1 MB edit limit)"
                              >
                                <Eye className="mr-1 h-3 w-3" /> View
                              </Button>
                            )}
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => downloadEntry(entry)}
                              disabled={downloadingPath === (entry.is_dir ? `dir:${entry.path}` : entry.path)}
                              className="h-6 w-6 p-0 text-mil-dim hover:text-brand"
                              title={entry.is_dir ? 'Download folder as ZIP' : 'Download file'}
                            >
                              {downloadingPath === (entry.is_dir ? `dir:${entry.path}` : entry.path)
                                ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                : <Download className="h-3.5 w-3.5" />}
                            </Button>
                            <Button aria-label="Delete"
                              size="sm"
                              variant="ghost"
                              onClick={() => requestDelete([entry])}
                              className="h-6 w-6 p-0 text-mil-dim hover:text-red-400"
                              title={entry.is_dir ? 'Delete folder' : 'Delete file'}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </CardContent>
        </Card>

        {reading && (
          <Card className="border-zinc-800 bg-mil-bg-deep/60">
            <CardContent className="flex items-center justify-center py-10">
              <Loader2 className="h-5 w-5 animate-spin text-brand" />
            </CardContent>
          </Card>
        )}

        {readError && !reading && (
          <Card className="border-zinc-800 bg-mil-bg-deep/60">
            <CardContent className="py-6 text-center text-xs text-red-400">
              <AlertTriangle className="mx-auto mb-2 h-5 w-5" />
              {readError}
            </CardContent>
          </Card>
        )}

        {!reading && !readError && (
          <Card className="border-zinc-800 bg-mil-bg-deep/60">
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-xs font-semibold tracking-[0.06em] text-mil-muted">
                <FileText className="h-4 w-4 text-brand" /> Editor Workflow
              </CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-3 text-xs text-mil-dim md:flex-row md:items-center md:justify-between">
              <div>
                Open any editable file to launch the full editor dialog. Validate + format currently supports JSON, YAML, XML, TOML, INI, properties, Python, and CSV. AI assist now produces a preview first, with JSON as the main path.
              </div>
              <Button size="sm" variant="outline" onClick={openCreateDialog} className="h-8 shrink-0 border-zinc-800 text-xs text-mil-fg">
                <Plus className="mr-1 h-3.5 w-3.5" /> Create file
              </Button>
            </CardContent>
          </Card>
        )}

        <Dialog open={!!editFile} onOpenChange={(open) => { if (!open) closeEditor(); }}>
          <DialogContent className="flex h-[92dvh] w-[96vw] max-w-[96vw] flex-col gap-0 overflow-hidden border-[rgba(232,131,58,0.15)] bg-mil-bg-panel p-0 text-white sm:rounded-lg">
            {editFile && (
              <>
                <DialogHeader className="gap-3 border-b border-[rgba(232,131,58,0.12)] px-6 py-5">
                  <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
                    <div className="min-w-0">
                      <DialogTitle className="flex flex-wrap items-center gap-2 text-base tracking-[0.06em] text-mil-fg">
                        <FileText className="h-4 w-4 text-brand" />
                        <span className="truncate">{editFile.name}</span>
                        {editFile.isNew ? (
                          <Badge variant="outline" className="border-blue-500/30 text-[11px] text-blue-300">New Draft</Badge>
                        ) : null}
                        {editFile.readOnly ? (
                          <Badge variant="outline" className="border-zinc-600/40 text-[11px] text-mil-muted">Read-only</Badge>
                        ) : null}
                        {editDirty && !editFile.readOnly ? (
                          <Badge variant="outline" className="border-amber-600/30 text-[11px] text-amber-400">Unsaved</Badge>
                        ) : null}
                      </DialogTitle>
                      <DialogDescription className="mt-1 font-mono text-[11px] text-mil-dim" style={{ fontFamily: "var(--font-mono)" }}>
                        {formatFileManagerPath(editFile.root, editFile.path)}
                      </DialogDescription>
                      <p className="mt-2 text-[11px] text-mil-dim">
                        {editFile.readOnly
                          ? 'This file exceeds the 1 MB edit limit, so it opens read-only. Download it to keep a full copy.'
                          : 'Validate + format runs safe syntax checks first. AI assist uses the backend OpenAI key and now produces a review preview before anything touches your draft.'}
                      </p>
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                      {editFile.readOnly ? (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => downloadEntry({ name: editFile.name, path: editFile.path })}
                          disabled={downloadingPath === editFile.path}
                          className="h-8 border-zinc-800 text-xs text-mil-fg"
                        >
                          {downloadingPath === editFile.path
                            ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                            : <Download className="mr-1 h-3.5 w-3.5" />}
                          Download
                        </Button>
                      ) : (
                        <>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={validateFile}
                            disabled={saving || validating || assisting}
                            className="h-8 border-zinc-800 text-xs text-mil-fg"
                          >
                            {validating ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <ShieldCheck className="mr-1 h-3.5 w-3.5" />}
                            Validate + format
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={runAiAssist}
                            disabled={saving || validating || assisting}
                            className="h-8 border-zinc-800 text-xs text-mil-fg"
                          >
                            {assisting ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Sparkles className="mr-1 h-3.5 w-3.5" />}
                            AI assist
                          </Button>
                          <Button
                            size="sm"
                            onClick={saveFile}
                            disabled={saving || validating || assisting || (!editDirty && !editFile.isNew)}
                            className="h-8 bg-brand text-xs font-semibold text-black hover:bg-brand-light"
                          >
                            {saving ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Save className="mr-1 h-3.5 w-3.5" />}
                            Save
                          </Button>
                        </>
                      )}
                    </div>
                  </div>
                </DialogHeader>

                <div className="flex min-h-0 flex-1 flex-col px-6 pb-6">
                  {saveError ? (
                    <div className="mt-4 rounded border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
                      {saveError}
                    </div>
                  ) : null}
                  {editorStatus ? (
                    <div className={`mt-4 rounded border px-3 py-2 text-xs ${editorStatusToneClasses(editorStatus.tone)}`}>
                      {editorStatus.text}
                    </div>
                  ) : null}

                  {aiSuggestion ? (
                    <div className="mt-4 rounded border border-[rgba(232,131,58,0.18)] bg-mil-bg-deep/75 p-4">
                      <div className="flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between">
                        <div>
                          <div className="flex flex-wrap items-center gap-2 text-xs tracking-[0.06em] text-mil-fg">
                            <Sparkles className="h-3.5 w-3.5 text-brand" />
                            AI PREVIEW READY
                            {currentFileExtension === 'json' ? (
                              <Badge variant="outline" className="border-blue-500/30 text-[11px] text-blue-300">JSON</Badge>
                            ) : null}
                            <Badge variant="outline" className="border-zinc-700 text-[11px] text-mil-muted">
                              {aiChangedLines} changed line{aiChangedLines === 1 ? '' : 's'}
                            </Badge>
                          </div>
                          <p className="mt-2 text-xs text-mil-fg">{aiSuggestion.summary}</p>
                          {aiSuggestion.issues.length > 0 ? (
                            <div className="mt-2 flex flex-wrap gap-2">
                              {aiSuggestion.issues.slice(0, 3).map((issue) => (
                                <Badge key={issue} variant="outline" className="border-amber-500/20 text-[11px] text-amber-300">
                                  {issue}
                                </Badge>
                              ))}
                            </div>
                          ) : null}
                        </div>

                        <div className="flex flex-wrap gap-2">
                          <Button size="sm" variant="ghost" onClick={discardAiSuggestion} className="text-mil-muted hover:text-white">
                            Discard
                          </Button>
                          <Button size="sm" onClick={applyAiSuggestion} className="bg-brand text-black hover:bg-brand-light">
                            <CheckCircle className="mr-1 h-3.5 w-3.5" /> Apply suggestion
                          </Button>
                        </div>
                      </div>

                      <div className="mt-4 grid gap-3 xl:grid-cols-2">
                        <div className="min-w-0 rounded border border-zinc-800 bg-mil-bg-deep/80">
                          <div className="border-b border-zinc-800 px-3 py-2 text-[11px] text-mil-dim">
                            Current Draft
                          </div>
                          <pre className="max-h-[24dvh] overflow-auto whitespace-pre-wrap wrap-break-word px-3 py-3 font-mono text-[11px] leading-5 text-mil-muted" style={{ fontFamily: "var(--font-mono)" }}>
                            {aiSuggestion.originalContent}
                          </pre>
                        </div>

                        <div className="min-w-0 rounded border border-brand/20 bg-[#141414]">
                          <div className="border-b border-brand/10 px-3 py-2 text-[11px] text-brand">
                            Proposed Result
                          </div>
                          <pre className="max-h-[24dvh] overflow-auto whitespace-pre-wrap wrap-break-word px-3 py-3 font-mono text-[11px] leading-5 text-[#d8f3dc]" style={{ fontFamily: "var(--font-mono)" }}>
                            {aiSuggestion.correctedContent}
                          </pre>
                        </div>
                      </div>
                    </div>
                  ) : null}

                  <div className="mt-4 flex flex-wrap items-center justify-between gap-2 text-[11px] text-mil-dim">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant="outline" className="border-zinc-700 text-[11px] text-mil-muted">
                        {ROOT_LABELS[editFile.root] || editFile.root}
                      </Badge>
                      <Badge variant="outline" className="border-zinc-700 text-[11px] text-mil-muted">
                        {currentFileExtension ? `.${currentFileExtension}` : 'text'}
                      </Badge>
                      <span>
                        {editFile.modified ? `Last saved ${formatDate(editFile.modified)}` : 'Draft not saved yet'}
                      </span>
                    </div>
                    <div>{currentLineCount.toLocaleString()} lines • {editContent.length.toLocaleString()} chars</div>
                  </div>

                  {editFile.readOnly ? (
                    <>
                      {editFile.viewOffset > 0 ? (
                        <div className="mt-4 flex flex-wrap items-center justify-between gap-2 rounded-md border border-zinc-800 bg-mil-bg-deep/60 px-3 py-2 text-[11px] text-mil-muted">
                          <span>
                            Showing the newest {formatBytes(editFile.size - editFile.viewOffset)} of {formatBytes(editFile.size)}.
                          </span>
                          {editFile.size - editFile.viewOffset < LOG_VIEW_MAX_BYTES ? (
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={loadEarlier}
                              disabled={loadingEarlier}
                              className="h-7 border-zinc-700 px-3 text-[11px] text-mil-fg hover:border-brand/40 hover:text-brand"
                            >
                              {loadingEarlier ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : null}
                              Load earlier
                            </Button>
                          ) : (
                            <span>Download the file to see the rest.</span>
                          )}
                        </div>
                      ) : null}
                      <pre
                        ref={setLogView}
                        className="mt-4 min-h-0 flex-1 overflow-auto whitespace-pre rounded-md border border-zinc-800 bg-mil-bg-deep/90 p-3 font-mono text-xs leading-5 text-[#d8f3dc]"
                        style={{ fontFamily: "var(--font-mono)" }}
                      >
                        {editContent}
                      </pre>
                    </>
                  ) : (
                    <Textarea
                      value={editContent}
                      onChange={(event) => {
                        setEditContent(event.target.value);
                        setEditDirty(true);
                        if (saveError) setSaveError(null);
                      }}
                      className="mt-4 min-h-0 flex-1 resize-none border-zinc-800 bg-mil-bg-deep/90 font-mono text-xs leading-5 text-[#d8f3dc] placeholder:text-mil-dim"
                      style={{ fontFamily: "var(--font-mono)" }}
                      spellCheck={false}
                    />
                  )}

                  <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-[11px] text-mil-dim">
                    <span>
                      {editFile.readOnly
                        ? 'Read-only view of the newest part — this file is too large to edit in the browser. Use Download for the full copy.'
                        : 'Validation and AI suggestions stay local until you click Save. AI output must be applied from the preview first.'}
                    </span>
                    <span>{formatFileManagerPath(editFile.root, editFile.path)}</span>
                  </div>
                </div>
              </>
            )}
          </DialogContent>
        </Dialog>

        <Dialog open={createDialogOpen} onOpenChange={(open) => { if (!open) resetCreateDialog(); }}>
          <DialogContent className="w-[95vw] max-w-lg border-[rgba(232,131,58,0.15)] bg-mil-bg-panel text-white">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 text-sm tracking-[0.06em] text-mil-fg">
                <Plus className="h-4 w-4 text-brand" /> Create File Draft
              </DialogTitle>
              <DialogDescription className="text-xs text-mil-dim">
                The draft opens immediately in the editor and is only written to the server after you click save.
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-4">
              {createError ? (
                <div className="rounded border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
                  {createError}
                </div>
              ) : null}

              <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_220px]">
                <div className="space-y-2">
                  <label className="text-xs font-medium text-mil-muted">File Name</label>
                  <Input
                    value={newFileName}
                    onChange={(event) => {
                      setNewFileName(event.target.value);
                      if (createError) setCreateError('');
                    }}
                    placeholder="server-settings"
                    className="h-9 border-zinc-800 bg-mil-bg-deep/60 text-white"
                  />
                </div>

                <div className="space-y-2">
                  <label className="text-xs font-medium text-mil-muted">Extension</label>
                  <Select value={newFileExtension} onValueChange={setNewFileExtension}>
                    <SelectTrigger className="h-9 border-zinc-800 bg-mil-bg-deep/60 text-white">
                      <SelectValue placeholder="Select extension" />
                    </SelectTrigger>
                    <SelectContent className="border-[rgba(232,131,58,0.15)] bg-mil-bg-panel text-white">
                      {NEW_FILE_EXTENSION_OPTIONS.map((option) => (
                        <SelectItem key={option.value} value={option.value} className="text-sm text-mil-fg focus:bg-[#1c1c1c] focus:text-white">
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="rounded border border-zinc-800/70 bg-mil-bg-deep/50 px-3 py-3">
                <div className="text-xs text-mil-muted font-medium">Target Path</div>
                <div className="mt-1 font-mono text-xs text-mil-fg" style={{ fontFamily: "var(--font-mono)" }}>
                  {formatFileManagerPath(activeRoot, draftPreviewPath)}
                </div>
              </div>

              <div className="flex flex-wrap justify-end gap-2">
                <Button size="sm" variant="ghost" onClick={resetCreateDialog} className="text-mil-muted hover:text-white">
                  Cancel
                </Button>
                <Button size="sm" onClick={createFileDraft} className="bg-brand text-black hover:bg-brand-light">
                  <Edit3 className="mr-1 h-3.5 w-3.5" /> Open draft
                </Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>

        <Dialog open={deleteTargets.length > 0} onOpenChange={(open) => { if (!open) cancelDelete(); }}>
          <DialogContent className="w-[95vw] max-w-lg border-red-600/25 bg-mil-bg-panel text-white">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 text-sm tracking-[0.06em] text-red-300">
                <Trash2 className="h-4 w-4" /> Delete {deleteTargets.length} Item{deleteTargets.length === 1 ? '' : 's'}
              </DialogTitle>
              <DialogDescription className="text-xs text-mil-dim">
                This permanently removes the selected items from{' '}
                <span className="font-mono text-mil-muted">{formatFileManagerPath(activeRoot, currentPath)}</span>. Folders are deleted with all of their contents. This cannot be undone.
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-4">
              {deleteTargets.some((t) => t.is_dir) && (
                <div className="flex items-start gap-2 rounded border border-red-600/30 bg-red-600/10 px-3 py-2 text-xs text-red-300">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  Your selection includes folders. Every file and subfolder inside them will be removed recursively.
                </div>
              )}

              <div className="max-h-[34dvh] overflow-y-auto rounded border border-zinc-800/70 bg-mil-bg-deep/50">
                <ul className="divide-y divide-zinc-800/40">
                  {deleteTargets.map((t) => (
                    <li key={t.path} className="flex items-center gap-2 px-3 py-2 text-xs">
                      {t.is_dir ? <Folder className="h-3.5 w-3.5 shrink-0 text-brand" /> : <File className="h-3.5 w-3.5 shrink-0 text-mil-dim" />}
                      <span className="truncate text-mil-fg">{t.name}</span>
                      {t.is_dir && <Badge variant="outline" className="ml-auto shrink-0 border-amber-600/30 text-[11px] text-amber-400">folder</Badge>}
                    </li>
                  ))}
                </ul>
              </div>

              <div className="flex flex-wrap justify-end gap-2">
                <Button size="sm" variant="ghost" onClick={cancelDelete} disabled={deleting} className="text-mil-muted hover:text-white">
                  Cancel
                </Button>
                <Button
                  size="sm"
                  onClick={confirmDelete}
                  disabled={deleting}
                  className="bg-red-700 text-white hover:bg-red-600"
                >
                  {deleting ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Trash2 className="mr-1 h-3.5 w-3.5" />}
                  Delete {deleteTargets.length} item{deleteTargets.length === 1 ? '' : 's'}
                </Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>
      </>
    );
  }
}

export default FileManagerModule;
