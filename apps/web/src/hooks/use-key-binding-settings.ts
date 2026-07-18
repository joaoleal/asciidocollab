'use client';
import { useState, useEffect, useCallback } from 'react';
import type { KeyBindingDto } from '@asciidocollab/shared';
import { API_BASE_URL } from '@/lib/api/base-url';

/** Groups key bindings by their namespace for display in the settings UI. */
export interface KeyBindingGroup {
  /** The namespace prefix shared by all bindings in this group (e.g., 'file-tree'). */
  namespace: string;
  /** Human-readable label derived from the namespace. */
  label: string;
  /** All key bindings belonging to this namespace group. */
  bindings: KeyBindingDto[];
}

/** React hook for loading, updating, and resetting user key binding preferences. */
export function useKeyBindingSettings() {
  const [bindings, setBindings] = useState<KeyBindingDto[]>([]);

  const fetchAll = useCallback(async () => {
    try {
      const r = await fetch(`${API_BASE_URL}/auth/me/keybindings`, { credentials: 'include' });
      if (r.ok) setBindings(await r.json());
    } catch {
      // Silently ignore fetch errors; bindings stay empty
    }
  }, []);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  const groups: KeyBindingGroup[] = [];
  const namespaceMap = new Map<string, KeyBindingDto[]>();
  for (const b of bindings) {
    const [namespace] = b.action.split(':');
    if (!namespaceMap.has(namespace)) namespaceMap.set(namespace, []);
    namespaceMap.get(namespace)!.push(b);
  }
  for (const [namespace, nsBindings] of namespaceMap) {
    groups.push({ namespace, label: namespace.replaceAll('-', ' ').replaceAll(/\b\w/g, (c) => c.toUpperCase()), bindings: nsBindings });
  }

  const updateBinding = useCallback(async (action: string, keyCombo: string) => {
    const previousBindings = bindings;
    setBindings((previous) => previous.map((b) => b.action === action ? { ...b, keyCombo, isDefault: false } : b));

    try {
      const r = await fetch(`${API_BASE_URL}/auth/me/keybindings/${encodeURIComponent(action)}`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keyCombo }),
      });
      if (!r.ok) {
        setBindings(previousBindings);
        const body = await r.json().catch(() => ({}));
        throw new Error(body?.error?.message ?? 'Update failed');
      }
    } catch (error) {
      setBindings(previousBindings);
      throw error;
    }
  }, [bindings]);

  const resetBinding = useCallback(async (action: string) => {
    const previousBindings = bindings;
    try {
      const r = await fetch(`${API_BASE_URL}/auth/me/keybindings/${encodeURIComponent(action)}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      if (!r.ok) {
        throw new Error('Reset failed');
      }
      await fetchAll();
    } catch (error) {
      setBindings(previousBindings);
      throw error;
    }
  }, [bindings, fetchAll]);

  return { groups, updateBinding, resetBinding };
}
