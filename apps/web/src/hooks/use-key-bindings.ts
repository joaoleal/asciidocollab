'use client';
import { useState, useEffect } from 'react';
import { API_BASE_URL } from '@/lib/api/base-url';

/** React hook that fetches the current user's key bindings for a given namespace as an action-to-keyCombo map. */
export function useKeyBindings(namespace: string): Map<string, string> {
  const [bindings, setBindings] = useState<Map<string, string>>(new Map());

  useEffect(() => {
    fetch(`${API_BASE_URL}/auth/me/keybindings?namespace=${encodeURIComponent(namespace)}`, { credentials: 'include' })
      .then((r) => r.ok ? r.json() : [])
      .then((data: Array<{ action: string; keyCombo: string }>) => {
        setBindings(new Map(data.map((b) => [b.action, b.keyCombo])));
      })
      .catch(() => {});
  }, [namespace]);

  return bindings;
}
