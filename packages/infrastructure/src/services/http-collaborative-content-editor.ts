import type {
  CollaborativeContentEditor,
  CollaborativeContentReader,
  CollaborativeContentWriter,
  ContentReplacement,
  ProjectId,
  YjsStateId,
  Result,
} from '@asciidocollab/domain';
import { createMtlsFetch } from './mtls-fetch';

/** Path of the internal apply-edits endpoint on the collaboration server. */
export const COLLAB_APPLY_EDITS_PATH = '/internal/collab/apply-edits';

/** Path of the internal read-content endpoint on the collaboration server. */
export const COLLAB_READ_CONTENT_PATH = '/internal/collab/read-content';

/** Path of the internal apply-full-content endpoint on the collaboration server. */
export const COLLAB_APPLY_FULL_CONTENT_PATH = '/internal/collab/apply-full-content';

// Strip trailing '/' characters. Linear-time (no regex) to keep it ReDoS-free; equivalent to
// `s.replace(/\/+$/, '')`.
function stripTrailingSlashes(s: string): string {
  let end = s.length;
  while (end > 0 && s[end - 1] === '/') end--;
  return s.slice(0, end);
}

/** Configuration for the HTTP collaborative-content editor adapter. */
export interface HttpCollaborativeContentEditorConfig {
  /** Base URL of the collaboration server's internal HTTP endpoint (e.g., `http://127.0.0.1:4003`). */
  baseUrl: string;
  /** Optional shared secret sent as `x-collab-internal-secret` (defense-in-depth on the loopback path). */
  secret?: string;
  /** Request timeout in milliseconds. */
  timeoutMs?: number;
  /** Client mTLS material; when set (and no explicit `fetch`), requests present this client certificate. */
  tls?: { cert: Buffer; key: Buffer; ca: Buffer };
  /** Injectable fetch (overrides `tls`); defaults to an mTLS fetch when `tls` is set, else the global fetch. */
  fetch?: typeof globalThis.fetch;
}

/**
 * {@link CollaborativeContentEditor} + {@link CollaborativeContentReader} implementation that
 * delegates to the collaboration server over an internal HTTP call. The collab server owns the live
 * Yjs documents, so it is the only process that can apply an edit to — or read the current text of —
 * the source of truth (via `openDirectConnection`); this adapter is the api-side client that asks it
 * to. Transport-only — it carries no business logic.
 */
export class HttpCollaborativeContentEditor
  implements CollaborativeContentEditor, CollaborativeContentReader, CollaborativeContentWriter
{
  private readonly fetchImpl: typeof globalThis.fetch;

  /** @param config - Base URL, optional secret/timeout, and either mTLS material or an injected fetch. */
  constructor(private readonly config: HttpCollaborativeContentEditorConfig) {
    this.fetchImpl =
      config.fetch ?? (config.tls ? createMtlsFetch(config.tls.cert, config.tls.key, config.tls.ca) : globalThis.fetch);
  }

  /**
   * POSTs a JSON body to an internal collab endpoint with the shared headers, optional secret, and
   * timeout. Centralised so both methods build the request — and apply the auth secret — identically.
   *
   * @param path - The endpoint path (such as apply-edits or read-content).
   * @param body - The JSON-serialisable request body.
   * @param label - Short operation name used in the not-ok error message.
   * @returns The response on a 2xx, or an error (transport failure or non-2xx).
   */
  private async post(path: string, body: unknown, label: string): Promise<Result<Response, Error>> {
    const url = `${stripTrailingSlashes(this.config.baseUrl)}${path}`;
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.config.secret) headers['x-collab-internal-secret'] = this.config.secret;

    try {
      const response = await this.fetchImpl(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.config.timeoutMs ?? 5000),
      });
      if (!response.ok) {
        return { success: false, error: new Error(`${label} failed with status ${response.status}`) };
      }
      return { success: true, value: response };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error : new Error(String(error)) };
    }
  }

  /** Posts the replacements to the collab server's apply-edits endpoint, returning the apply count. */
  async applyReplacements(
    projectId: ProjectId,
    yjsStateId: YjsStateId,
    replacements: ReadonlyArray<ContentReplacement>,
  ): Promise<Result<number, Error>> {
    if (replacements.length === 0) return { success: true, value: 0 };

    const posted = await this.post(
      COLLAB_APPLY_EDITS_PATH,
      {
        projectId: projectId.value,
        yjsStateId: yjsStateId.value,
        replacements: replacements.map((r) => ({ find: r.find, replace: r.replace })),
      },
      'apply-edits',
    );
    if (!posted.success) return posted;

    // The endpoint reports how many occurrences it actually replaced; the caller uses 0 to detect
    // that the live document had diverged from what it scanned (nothing was rewritten).
    const body: unknown = await posted.value.json();
    if (typeof body !== 'object' || body === null || !('applied' in body) || typeof body.applied !== 'number') {
      return { success: false, error: new Error('apply-edits returned a malformed body') };
    }
    return { success: true, value: body.applied };
  }

  /** Reads the live document text from the collab server's read-content endpoint (null = no live source). */
  async readContent(projectId: ProjectId, yjsStateId: YjsStateId): Promise<Result<string | null, Error>> {
    const posted = await this.post(
      COLLAB_READ_CONTENT_PATH,
      { projectId: projectId.value, yjsStateId: yjsStateId.value },
      'read-content',
    );
    if (!posted.success) return posted;

    const body: unknown = await posted.value.json();
    // `content` is the live text, or null when the document has no live source (caller uses the file store).
    if (typeof body !== 'object' || body === null || !('content' in body) || (typeof body.content !== 'string' && body.content !== null)) {
      return { success: false, error: new Error('read-content returned a malformed body') };
    }
    return { success: true, value: body.content };
  }

  /** Posts the full replacement content to the collab server's apply-full-content endpoint. */
  async replaceContent(projectId: ProjectId, yjsStateId: YjsStateId, targetContent: string): Promise<Result<void, Error>> {
    const posted = await this.post(
      COLLAB_APPLY_FULL_CONTENT_PATH,
      { projectId: projectId.value, yjsStateId: yjsStateId.value, content: targetContent },
      'apply-full-content',
    );
    if (!posted.success) return posted;

    return { success: true, value: undefined };
  }
}
