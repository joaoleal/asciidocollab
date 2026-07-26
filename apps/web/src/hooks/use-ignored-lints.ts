'use client';

/**
 * Loads and persists the caller's private ignored-lints blob for a document (feature 042 / US6). The
 * blob is the opaque, privacy-hashed output of harper.js `exportIgnoredLints()` — never document prose.
 * It is fetched once on document open (to `importIgnoredLints` into the worker, done by the caller that
 * owns the client) and PUT back after each ignore/un-ignore so it survives reload and other devices.
 */
import { useCallback, useEffect, useState } from 'react';
import { grammarApi } from '@/lib/api/grammar';
import { ApiError } from '@/lib/api/transport';

/** The state and actions exposed for a document's ignored-lints blob. */
export interface UseIgnoredLints {
  /** The caller's privacy-hashed ignored-lints blob (empty string until loaded, or when none). */
  blob: string;
  /** True while the initial fetch is in flight. */
  loading: boolean;
  /** The last load/save error message, or null. */
  error: string | null;
  /**
   * Persist a new blob (full replace of the caller's record for this document).
   *
   * @param blob - The exported ignored-lints blob to persist.
   * @returns Whether the save succeeded.
   */
  save: (blob: string) => Promise<boolean>;
}

/**
 * React hook over the document ignored-lints API.
 *
 * @param documentId - The document whose ignored-lints to manage, or null when none is open.
 * @returns The blob state and the save action.
 */
export function useIgnoredLints(documentId: string | null): UseIgnoredLints {
  const [blob, setBlob] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!documentId) {
      setBlob('');
      setLoading(false);
      return;
    }
    let active = true;
    setLoading(true);
    grammarApi
      .getIgnoredLints(documentId)
      .then((response) => {
        if (active) {
          setBlob(response.data.ignoredLintsJson);
          setError(null);
        }
      })
      .catch((error_: unknown) => {
        if (active) setError(error_ instanceof ApiError ? error_.message : 'Failed to load ignored issues.');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [documentId]);

  const save = useCallback(
    async (next: string): Promise<boolean> => {
      if (!documentId) return false;
      try {
        await grammarApi.putIgnoredLints(documentId, next);
        setBlob(next);
        setError(null);
        return true;
      } catch (error_) {
        setError(error_ instanceof ApiError ? error_.message : 'Failed to save ignored issues.');
        return false;
      }
    },
    [documentId],
  );

  return { blob, loading, error, save };
}
