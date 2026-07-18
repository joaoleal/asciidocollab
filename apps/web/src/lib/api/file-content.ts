import { API_BASE_URL } from './base-url';

// Re-exported for the many call sites that already import it from here.
// `export…from` rather than exporting the local binding, per unicorn/prefer-export-from.
export { API_BASE_URL } from './base-url';

/** Builds the canonical content URL for a project file. */
export function fileContentUrl(projectId: string, fileNodeId: string): string {
  return `${API_BASE_URL}/projects/${projectId}/files/${fileNodeId}/content`;
}

/** Fetches the raw text content of a document file. */
export async function getDocumentContent(projectId: string, fileNodeId: string): Promise<string> {
  const response = await fetch(
    fileContentUrl(projectId, fileNodeId),
    { credentials: 'include' },
  );

  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body?.error?.message ?? `Failed to fetch content: ${response.status}`);
  }

  return response.text();
}

/**
 * Saves updated text content for a document file.
 *  Returns the ETag from the response so callers can seed external-change polling.
 */
export async function saveDocumentContent(
  projectId: string,
  fileNodeId: string,
  content: string,
): Promise<{ etag: string | null }> {
  const response = await fetch(
    fileContentUrl(projectId, fileNodeId),
    {
      method: 'PUT',
      credentials: 'include',
      headers: { 'Content-Type': 'text/plain' },
      body: content,
    },
  );

  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body?.error?.message ?? `Failed to save content: ${response.status}`);
  }

  return { etag: response.headers.get('ETag') };
}
