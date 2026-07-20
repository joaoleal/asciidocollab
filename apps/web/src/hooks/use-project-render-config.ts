'use client';

/**
 * Loads and persists a project's render configuration. The loaded config feeds the composition root's
 * attribute seam (so both the HTML preview and the PDF export honour it) and the project-settings UI.
 */
import { useCallback, useEffect, useState } from 'react';
import { renderConfigApi } from '@/lib/api/render-config';
import { ApiError } from '@/lib/api/transport';
import type { RenderConfig } from '@asciidocollab/shared';

/** The state and actions exposed for a project's render configuration. */
export interface UseProjectRenderConfig {
  /** The current configuration (empty until loaded, and when none is set). */
  config: RenderConfig;
  /** True while the initial fetch is in flight. */
  loading: boolean;
  /**
   * True once the stored configuration has actually been READ.
   *
   * Distinct from `!loading`, and the distinction is load-bearing: a failed fetch also ends the
   * loading state, but leaves `config` at its empty default — indistinguishable from a project that
   * has stored nothing. Saving is a whole-document replace, so an editor that seeded its draft from
   * that empty default and let the viewer save would erase every setting the project had. A consumer
   * must not offer editing until this is true. `error` is NOT a substitute: it is also set by a
   * failed save, after which the draft is real and editing must remain possible.
   */
  loaded: boolean;
  /** True while a save is in flight. */
  saving: boolean;
  /** The last load/save error message, or null. */
  error: string | null;
  /**
   * Persist a new configuration; resolves true on success, false on failure.
   *
   * @param next - The configuration to persist.
   */
  save: (next: RenderConfig) => Promise<boolean>;
}

const EMPTY: RenderConfig = {};

/** React hook over the project render-config API. */
export function useProjectRenderConfig(projectId: string): UseProjectRenderConfig {
  const [config, setConfig] = useState<RenderConfig>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    // Cleared for the new project: leaving it set would let an editor seed its draft from the
    // PREVIOUS project's configuration while this one's fetch is still in flight.
    setLoaded(false);
    setError(null);
    renderConfigApi
      .get(projectId)
      .then((response) => {
        if (active) {
          setConfig(response.data);
          setLoaded(true);
        }
      })
      .catch((error_: unknown) => {
        if (active) {
          setError(error_ instanceof ApiError ? error_.message : 'Failed to load render configuration.');
        }
      })
      .finally(() => {
        if (active) {
          setLoading(false);
        }
      });
    return () => {
      active = false;
    };
  }, [projectId]);

  const save = useCallback(
    async (next: RenderConfig): Promise<boolean> => {
      setSaving(true);
      setError(null);
      try {
        const response = await renderConfigApi.save(projectId, next);
        setConfig(response.data);
        return true;
      } catch (error_) {
        setError(error_ instanceof ApiError ? error_.message : 'Failed to save render configuration.');
        return false;
      } finally {
        setSaving(false);
      }
    },
    [projectId],
  );

  return { config, loading, loaded, saving, error, save };
}
