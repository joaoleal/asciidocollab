'use client';

/**
 * Loads the PDF converter-extension catalogue for a project.
 *
 * Read-only: the project's SELECTION lives in the render config and is edited through that draft, so
 * this hook supplies only what is on offer. Keeping the two apart is what stops the extensions
 * section saving a partial config and wiping its sibling sections.
 */
import { useEffect, useState } from 'react';
import { pdfExtensionsApi, type PdfExtensionCatalogue } from '@/lib/api/pdf-extensions';
import { ApiError } from '@/lib/api/transport';

/** The catalogue and its load state. */
export interface UsePdfExtensions {
  /** The assembled catalogue, or null until it loads. */
  catalogue: PdfExtensionCatalogue | null;
  /** True while the first fetch is in flight. */
  loading: boolean;
  /** The load error message, or null. */
  error: string | null;
}

const EMPTY: PdfExtensionCatalogue = {
  entries: [],
  staleSelections: [],
  excluded: [],
  conflicts: [],
};

/** React hook over the project's extension catalogue. */
export function usePdfExtensions(projectId: string): UsePdfExtensions {
  const [catalogue, setCatalogue] = useState<PdfExtensionCatalogue | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    pdfExtensionsApi
      .get(projectId)
      .then((response) => {
        if (active) setCatalogue(response.data ?? EMPTY);
      })
      .catch((error_: unknown) => {
        if (active) {
          setError(error_ instanceof ApiError ? error_.message : 'Failed to load PDF extensions.');
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [projectId]);

  return { catalogue, loading, error };
}
