'use client';

/**
 * Loads and mutates a project's shared grammar dictionary (feature 042 / US5). The term list is fetched
 * once on mount and hydrated into each collaborator's in-worker Harper linter via batched `importWords`
 * (done by the caller, which owns the worker client); adding or removing a term refetches so every
 * collaborator converges on the server's authoritative set.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { grammarApi } from '@/lib/api/grammar';
import { ApiError } from '@/lib/api/transport';
import type { DictionaryTermDto } from '@asciidocollab/shared';

/** The state and actions exposed for a project's shared dictionary. */
export interface UseProjectDictionary {
  /** The current accepted term records (empty until loaded), for management (removal needs the id). */
  entries: DictionaryTermDto[];
  /** The accepted terms as plain strings, for the linter's `importWords` hydration. */
  terms: string[];
  /** True while the initial fetch is in flight. */
  loading: boolean;
  /** The last load/mutation error message, or null. */
  error: string | null;
  /**
   * Add a term (editor/owner). Optimistically appends and refetches; resolves true on success.
   *
   * @param term - The term to add.
   * @returns Whether the add succeeded.
   */
  addTerm: (term: string) => Promise<boolean>;
  /**
   * Remove a term by id (editor/owner). Refetches; resolves true on success.
   *
   * @param termId - The id of the term to remove.
   * @returns Whether the removal succeeded.
   */
  removeTerm: (termId: string) => Promise<boolean>;
  /** Refetch the term list from the server. */
  refetch: () => Promise<void>;
}

/**
 * React hook over the project dictionary API.
 *
 * @param projectId - The project whose dictionary to manage.
 * @returns The dictionary state and mutation actions.
 */
export function useProjectDictionary(projectId: string): UseProjectDictionary {
  const [entries, setEntries] = useState<DictionaryTermDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const terms = useMemo(() => entries.map((entry) => entry.term), [entries]);

  const refetch = useCallback(async () => {
    if (!projectId) return;
    try {
      const response = await grammarApi.listDictionary(projectId);
      setEntries(response.data.terms);
      setError(null);
    } catch (error_) {
      setError(error_ instanceof ApiError ? error_.message : 'Failed to load the project dictionary.');
    }
  }, [projectId]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    refetch().finally(() => {
      if (active) setLoading(false);
    });
    return () => {
      active = false;
    };
  }, [refetch]);

  const addTerm = useCallback(
    async (term: string): Promise<boolean> => {
      try {
        const response = await grammarApi.addDictionaryTerm(projectId, term);
        // Optimistic append (case-insensitive dedupe already happened server-side).
        setEntries((previous) =>
          previous.some((entry) => entry.term.toLowerCase() === response.data.term.toLowerCase())
            ? previous
            : [...previous, response.data],
        );
        setError(null);
        return true;
      } catch (error_) {
        setError(error_ instanceof ApiError ? error_.message : 'Failed to add the term.');
        return false;
      }
    },
    [projectId],
  );

  const removeTerm = useCallback(
    async (termId: string): Promise<boolean> => {
      try {
        await grammarApi.removeDictionaryTerm(projectId, termId);
        await refetch();
        return true;
      } catch (error_) {
        setError(error_ instanceof ApiError ? error_.message : 'Failed to remove the term.');
        return false;
      }
    },
    [projectId, refetch],
  );

  return { entries, terms, loading, error, addTerm, removeTerm, refetch };
}
