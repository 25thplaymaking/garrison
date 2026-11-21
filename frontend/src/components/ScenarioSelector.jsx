import React, { useCallback, useEffect, useRef, useState } from 'react';
import apiClient from '@/lib/apiClient';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ChevronDown, Loader2, Plus, Trash2, Map, Puzzle, PenLine, Star } from 'lucide-react';
import { toast } from '@/hooks/use-toast';
/**
 * ScenarioSelector – replaces the plain scenarioId text input.
 *
 * Shows a dropdown with four groups:
 *   1. Vanilla (built-in Arma Reforger scenarios)
 *   2. Shared (scenarios promoted to the cross-server library)
 *   3. Mod (scenarios detected from enabled mods)
 *   4. Server-only (user-added manual entries)
 *
 * Also provides a manual input area to add server-only scenario IDs.
 * Server-only scenarios can be removed from the list.
 */
export default function ScenarioSelector({ value, onChange, serverId, refreshTrigger }) {
  const [scenarios, setScenarios] = useState({ vanilla: [], shared: [], mod: [], custom: [] });
  const [loading, setLoading] = useState(false);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [manualInput, setManualInput] = useState('');
  const [savingCustom, setSavingCustom] = useState(false);
  const dropdownRef = useRef(null);

  // Close dropdown on click outside
  useEffect(() => {
    if (!dropdownOpen) return;
    const handler = (e) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target)) {
        setDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [dropdownOpen]);

  const fetchScenarios = useCallback(async () => {
    if (!serverId) return;
    setLoading(true);
    try {
      const res = await apiClient.get(`/servers/${serverId}/scenarios`);
      setScenarios({
        vanilla: res.data?.vanilla || [],
        shared: res.data?.shared || [],
        mod: res.data?.mod || [],
        custom: res.data?.custom || [],
      });
    } catch {
      // Keep current state on failure
    } finally {
      setLoading(false);
    }
  }, [serverId]);

  useEffect(() => {
    fetchScenarios();
  }, [fetchScenarios]);

  // Re-fetch whenever ModsModule saves a new load order (refreshTrigger increments)
  useEffect(() => {
    if (refreshTrigger) fetchScenarios();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshTrigger]);

  const allScenarios = [
    ...scenarios.vanilla,
    ...scenarios.shared,
    ...scenarios.mod,
    ...scenarios.custom,
  ];

  const selectedLabel = (() => {
    const match = allScenarios.find((s) => s.id === value);
    if (match) {
      if (match.source === 'vanilla') return `${match.name} (${match.map || 'Vanilla'})`;
      if (match.source === 'shared') {
        const scenarioName = match.name && match.name !== match.id ? match.name : match.id;
        const modLabel = match.mod_name ? `${match.mod_name} - ` : '';
        return `Shared - ${modLabel}${scenarioName}`;
      }
      if (match.source === 'mod') {
        const scenarioName = match.name && match.name !== match.id ? match.name : '';
        const modLabel = match.mod_name || 'Mod';
        return scenarioName ? `${modLabel} – ${scenarioName}` : `${modLabel} – ${match.id}`;
      }
      return match.name;
    }
    return value || 'Select a scenario…';
  })();

  const handleSelect = (scenarioId) => {
    onChange(scenarioId);
    setDropdownOpen(false);
  };

  const isScenarioSelectable = useCallback((scenario) => (
    scenario?.source !== 'shared' || scenario.available_on_server !== false
  ), []);

  const persistCustomScenarios = useCallback(async (updatedCustomIds) => {
    setSavingCustom(true);
    try {
      await apiClient.put(`/servers/${serverId}/scenarios`, {
        custom_scenarios: updatedCustomIds,
      });
      setScenarios((prev) => ({
        ...prev,
        custom: updatedCustomIds.map((id) => ({ id, name: id, source: 'custom' })),
      }));
      return true;
    } catch (err) {
      toast({
        variant: 'destructive',
        title: 'Failed to save scenario list',
        description: err.response?.data?.detail || err?.message || 'Could not save the server-only scenario list.',
      });
      return false;
    } finally {
      setSavingCustom(false);
    }
  }, [serverId]);

  const addCustomScenario = useCallback(async () => {
    const trimmed = manualInput.trim();
    if (!trimmed) return;

    // Avoid duplicates across all categories
    const exists = allScenarios.some((s) => s.id === trimmed);
    if (exists) {
      // Still select it even if it already exists
      onChange(trimmed);
      setManualInput('');
      return;
    }

    const customIds = [...scenarios.custom.map((s) => s.id), trimmed];
    const saved = await persistCustomScenarios(customIds);
    if (!saved) return;
    onChange(trimmed);
    setManualInput('');
  }, [manualInput, allScenarios, scenarios.custom, onChange, persistCustomScenarios]);

  const removeCustomScenario = useCallback(async (scenarioId) => {
    const customIds = scenarios.custom.map((s) => s.id).filter((id) => id !== scenarioId);
    const saved = await persistCustomScenarios(customIds);
    if (!saved) return;
    // If the removed scenario was selected, clear the selection
    if (value === scenarioId) {
      onChange('');
    }
  }, [scenarios.custom, value, onChange, persistCustomScenarios]);

  const sourceColor = (source) => {
    if (source === 'vanilla') return 'border-emerald-600/30 text-emerald-300';
    if (source === 'shared') return 'border-amber-500/30 text-amber-300';
    if (source === 'mod') return 'border-blue-600/30 text-blue-300';
    return 'border-zinc-700 text-mil-muted';
  };

  return (
    <div className="space-y-3">
      {/* Dropdown trigger */}
      <div className="relative" ref={dropdownRef}>
        <button
          type="button"
          onClick={() => setDropdownOpen((prev) => !prev)}
          className="flex w-full items-center justify-between rounded-md border border-zinc-800 bg-mil-bg-deep/60 px-3 py-2 text-left text-sm text-white transition-colors hover:border-zinc-700"
        >
          <span className={`truncate font-mono text-sm ${value ? 'text-white' : 'text-mil-dim'}`}>
            {loading ? 'Loading scenarios…' : selectedLabel}
          </span>
          <div className="flex items-center gap-1">
            {loading && <Loader2 className="h-3.5 w-3.5 animate-spin text-mil-dim" />}
            <ChevronDown className={`h-4 w-4 text-mil-dim transition-transform ${dropdownOpen ? 'rotate-180' : ''}`} />
          </div>
        </button>

        {/* Dropdown panel */}
        {dropdownOpen && (
          <div className="absolute z-50 mt-1 max-h-80 w-full overflow-y-auto rounded-lg border border-zinc-800 bg-zinc-950 shadow-xl">
            {/* Vanilla Scenarios */}
            {scenarios.vanilla.length > 0 && (
              <div>
                <div className="sticky top-0 border-b border-zinc-800 bg-zinc-950 px-3 py-1.5">
                  <span className="flex items-center gap-1.5 text-xs font-medium text-emerald-400">
                    <Map className="h-3 w-3" /> Vanilla Scenarios
                  </span>
                </div>
                {scenarios.vanilla.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => handleSelect(s.id)}
                    className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-zinc-900 ${value === s.id ? 'bg-zinc-900/80 text-brand' : 'text-mil-fg'}`}
                  >
                    <span className="flex-1 truncate">{s.name}</span>
                    <Badge variant="outline" className={`text-[11px] ${sourceColor('vanilla')}`}>{s.map}</Badge>
                  </button>
                ))}
              </div>
            )}

            {/* Shared Scenarios */}
            {scenarios.shared.length > 0 && (
              <div>
                <div className="sticky top-0 border-b border-zinc-800 bg-zinc-950 px-3 py-1.5">
                  <span className="flex items-center gap-1.5 text-xs font-medium text-amber-400">
                    <Star className="h-3 w-3" /> Shared Scenarios
                  </span>
                </div>
                {scenarios.shared.map((s, idx) => (
                  <button
                    key={`shared-${s.mod_id || 'none'}-${s.id}-${idx}`}
                    type="button"
                    onClick={() => handleSelect(s.id)}
                    disabled={!isScenarioSelectable(s)}
                    title={isScenarioSelectable(s) ? undefined : 'Enable the required mod on this server before selecting this scenario.'}
                    className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors ${
                      isScenarioSelectable(s)
                        ? `hover:bg-zinc-900 ${value === s.id ? 'bg-zinc-900/80 text-brand' : 'text-mil-fg'}`
                        : 'cursor-not-allowed text-mil-dim'
                    }`}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm">{s.name !== s.id ? s.name : ''}</span>
                      <span className="block truncate font-mono text-[11px] text-mil-dim">{s.id}</span>
                    </span>
                    <div className="flex items-center gap-1">
                      {s.mod_name && (
                        <Badge variant="outline" className={`text-[11px] ${sourceColor('shared')}`}>{s.mod_name}</Badge>
                      )}
                      {!isScenarioSelectable(s) && (
                        <Badge variant="outline" className="text-[11px] border-red-900/60 text-red-300">Requires mod</Badge>
                      )}
                    </div>
                  </button>
                ))}
              </div>
            )}

            {/* Mod Scenarios */}
            {scenarios.mod.length > 0 && (
              <div>
                <div className="sticky top-0 border-b border-zinc-800 bg-zinc-950 px-3 py-1.5">
                  <span className="flex items-center gap-1.5 text-xs font-medium text-blue-400">
                    <Puzzle className="h-3 w-3" /> Mod Scenarios
                  </span>
                </div>
                {scenarios.mod.map((s, idx) => (
                  <button
                    key={`${s.mod_id}-${s.id}-${idx}`}
                    type="button"
                    onClick={() => handleSelect(s.id)}
                    className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-zinc-900 ${value === s.id ? 'bg-zinc-900/80 text-brand' : 'text-mil-fg'}`}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm">{s.name !== s.id ? s.name : ''}</span>
                      <span className="block truncate font-mono text-[11px] text-mil-dim">{s.id}</span>
                    </span>
                    <div className="flex items-center gap-1">
                      {s.game_mode && (
                        <Badge variant="outline" className="text-[11px] border-zinc-700 text-mil-muted">{s.game_mode}</Badge>
                      )}
                      {s.player_count > 0 && (
                        <Badge variant="outline" className="text-[11px] border-zinc-700 text-mil-muted">{s.player_count}P</Badge>
                      )}
                      <Badge variant="outline" className={`text-[11px] ${sourceColor('mod')}`}>{s.mod_name || s.mod_id}</Badge>
                    </div>
                  </button>
                ))}
              </div>
            )}

            {/* Custom Scenarios */}
            {scenarios.custom.length > 0 && (
              <div>
                <div className="sticky top-0 border-b border-zinc-800 bg-zinc-950 px-3 py-1.5">
                  <span className="flex items-center gap-1.5 text-xs font-medium text-amber-400">
                    <PenLine className="h-3 w-3" /> Server-only Scenarios
                  </span>
                </div>
                {scenarios.custom.map((s) => (
                  <div key={s.id} className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => handleSelect(s.id)}
                      className={`flex min-w-0 flex-1 items-center gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-zinc-900 ${value === s.id ? 'bg-zinc-900/80 text-brand' : 'text-mil-fg'}`}
                    >
                      <span className="min-w-0 flex-1 truncate font-mono text-xs">{s.name}</span>
                    </button>
                    <button aria-label="Delete"
                      type="button"
                      onClick={(e) => { e.stopPropagation(); removeCustomScenario(s.id); }}
                      className="mr-2 rounded p-1 text-mil-dim transition-colors hover:bg-red-900/30 hover:text-red-400"
                      title="Remove custom scenario"
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </div>
                ))}
              </div>
            )}

            {allScenarios.length === 0 && !loading && (
              <div className="px-3 py-4 text-center text-xs text-mil-dim">
                No scenarios available. Add a server-only scenario below.
              </div>
            )}
          </div>
        )}
      </div>

      {/* Manual scenario input */}
      <div className="flex items-center gap-2">
        <Input
          value={manualInput}
          onChange={(e) => setManualInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && !savingCustom && addCustomScenario()}
          placeholder="Add a server-only scenario ID, e.g. {GUID}Missions/MyMission.conf"
          className="h-8 flex-1 border-zinc-800 bg-mil-bg-deep/60 font-mono text-xs text-white placeholder:text-mil-dim"
        />
        <Button
          size="sm"
          type="button"
          onClick={addCustomScenario}
          disabled={!manualInput.trim() || savingCustom}
          className="h-8 bg-brand px-3 text-black hover:bg-brand-light"
        >
          {savingCustom ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="mr-1 h-3.5 w-3.5" />}
          Add
        </Button>
      </div>

      {/* Current raw value display */}
      {value && (
        <div className="flex items-center gap-2 rounded border border-zinc-800/50 bg-mil-bg-deep/30 px-3 py-1.5">
          <span className="text-[11px] text-mil-dim">Active:</span>
          <span className="flex-1 truncate font-mono text-[11px] text-mil-muted">{value}</span>
        </div>
      )}
    </div>
  );
}
