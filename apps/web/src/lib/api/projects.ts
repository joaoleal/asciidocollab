import type { CloneProjectDto, ProjectDto } from '@asciidocollab/shared';
import { apiRequest } from '@/lib/api/transport';
import type { PaginatedResponse, PaginationParameters } from '@/lib/api/transport';
import { API_BASE_URL } from './base-url';

/** Role a user can hold within a project. */
export type ProjectMemberRole = 'viewer' | 'editor' | 'owner';

/** Represents a project resource returned by the API. */
export interface Project {
  /** Unique identifier for the project. */
  id: string;
  /** Human-readable name of the project. */
  name: string;
  /** Optional description of the project's purpose. */
  description: string | null;
  /** List of users who own this project, each identified by userId and displayName. */
  owners: { userId: string; displayName: string }[];
  /** Taxonomy tags associated with the project. */
  tags: string[];
  /** Identifier of the project's root folder, or null if none has been created. */
  rootFolderId: string | null;
  /** Configured main AsciiDoc file node id, or null when unset. */
  mainFileNodeId: string | null;
  /** Document/spellcheck language (ISO 639-1), or null when unset (editor uses its default). */
  language: string | null;
  /** ISO timestamp when the project was archived, or null if it is active. */
  archivedAt: string | null;
  /** Total number of members in the project, included in list responses. */
  memberCount?: number;
  /** Number of files (excluding folders) in the project, included in list responses. */
  fileCount?: number;
  /** The calling user's role in this project, included when fetching as an authenticated member. */
  role?: ProjectMemberRole;
  /** ISO timestamp when the project was created. */
  createdAt: string;
  /** ISO timestamp when the project was last updated. */
  updatedAt: string;
}

/**
 * Code the clone endpoint refuses with when the caller already has a copy running: the server
 * serialises clones per user, so a second attempt started before the first answers is turned away
 * with this. Named here, beside the request that provokes it, because more than one place has to
 * recognise it — the dialog to choose its wording, and a listing to know that the refusal stops
 * being true the moment the copy it blamed lands.
 */
export const CLONE_IN_PROGRESS_CODE = 'CLONE_IN_PROGRESS';

/** CRUD client for the project resource. */
export const projectsApi = {
  async list(parameters?: PaginationParameters): Promise<PaginatedResponse<Project>> {
    const searchParameters = new URLSearchParams();
    if (parameters?.page) searchParameters.set('page', parameters.page.toString());
    if (parameters?.limit) searchParameters.set('limit', parameters.limit.toString());
    if (parameters?.archived !== undefined)
      searchParameters.set('archived', parameters.archived.toString());

    const query = searchParameters.toString();
    return apiRequest(`/api/projects${query ? `?${query}` : ''}`);
  },

  async get(id: string): Promise<{ /** The retrieved project. */
  data: Project }> {
    return apiRequest(`/api/projects/${id}`);
  },

  async create(data: {
    /** Name for the new project. */
    name: string;
    /** Optional description for the new project. */
    description?: string;
    /** Optional taxonomy tags for the new project. */
    tags?: string[];
  }): Promise<{ /** The newly created project. */
  data: Project }> {
    return apiRequest('/api/projects', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },

  async update(
    id: string,
    data: { /** Updated project name. */
    name?: string; /** Updated project description. */
    description?: string; /** Updated taxonomy tags. */
    tags?: string[]; /** Updated document/spellcheck language (ISO 639-1), or null to clear. */
    language?: string | null },
  ): Promise<{ /** The updated project. */
  data: Project }> {
    return apiRequest(`/api/projects/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    });
  },

  async archive(id: string): Promise<{ /** Confirmation payload containing the archived project id and timestamp. */
  data: { /** Unique identifier of the archived project. */
  id: string; /** ISO timestamp when the project was archived. */
  archivedAt: string } }> {
    return apiRequest(`/api/projects/${id}/archive`, { method: 'POST' });
  },

  async restore(id: string): Promise<{ /** Confirmation payload containing the restored project id and cleared timestamp. */
  data: { /** Unique identifier of the restored project. */
  id: string; /** Always null after a successful restore. */
  archivedAt: null } }> {
    return apiRequest(`/api/projects/${id}/restore`, { method: 'POST' });
  },

  async clone(id: string, name: string): Promise<{ /** The newly created copy of the source project. */
  data: Project }> {
    // Typed as the shared request shape so a change to what the endpoint expects
    // is a compile error here rather than a rejected request at runtime.
    const body: CloneProjectDto = { name };
    return apiRequest(`/api/projects/${id}/clone`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  },

  async delete(id: string): Promise<{ /** Confirmation payload containing the deleted project id. */
  data: { /** Unique identifier of the deleted project. */
  id: string } }> {
    return apiRequest(`/api/projects/${id}`, { method: 'DELETE' });
  },
};

/**
 * Set or clear a project's configured main AsciiDoc file via
 * `PUT /projects/:projectId/main-file`. Passing null clears the configuration.
 * Authorization is enforced server-side in the use case (editors/owners only);
 * a 403 surfaces as a thrown error.
 *
 * @param projectId - The project to configure.
 * @param mainFileNodeId - The file node id to set as main, or null to clear.
 * @returns The updated project DTO.
 */
export async function setProjectMainFile(
  projectId: string,
  mainFileNodeId: string | null,
): Promise<ProjectDto> {
  const response = await fetch(`${API_BASE_URL}/projects/${projectId}/main-file`, {
    method: 'PUT',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mainFileNodeId }),
  });

  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    const error: Error & { status?: number; code?: string } = new Error(
      body?.error?.message ?? `Set main file failed: ${response.status}`,
    );
    error.status = response.status;
    error.code = body?.error?.code ?? 'SET_MAIN_FILE_ERROR';
    throw error;
  }

  const parsed: { data: ProjectDto } = await response.json();
  return parsed.data;
}

/** A single cross-file usage of a symbol (find-usages). */
export interface SymbolUsage {
  /** The file node containing the reference. */
  fileNodeId: string;
  /** The referencing file's project-relative path (no leading slash). */
  path: string;
  /** The kind of reference (`xref` / `attributeRef` / `definition` / …). */
  kind: string;
  /**
   * For a `definition` usage, which kind of definition it is — a derived `section` id, an explicit
   * `anchor`, or an `attribute`. A rename never rewrites a section heading, so a consumer deciding
   * whether the rename would touch an occurrence uses this to tell an unrelated same-id heading from a
   * real anchor/attribute definition. Absent for non-definition usages.
   */
  definitionKind?: 'section' | 'anchor' | 'attribute';
  /** The reference's character offset range within its file. */
  range: { from: number; to: number };
}

/** The kind of symbol a rename targets. */
export type RenameSymbolKind = 'anchor' | 'attribute';

/** Outcome of a successful project-wide symbol rename. */
export interface RenameSymbolResult {
  /** How many files were edited. */
  rewrittenFiles: number;
  /** How many individual occurrences were rewritten. */
  updatedReferences: number;
  /** Occurrences that could not be safely rewritten. */
  warnings: string[];
}

function refactoringError(response: Response, body: { error?: { message?: string; code?: string } }, fallback: string): Error & { status?: number; code?: string } {
  const error: Error & { status?: number; code?: string } = new Error(body?.error?.message ?? `${fallback}: ${response.status}`);
  error.status = response.status;
  error.code = body?.error?.code ?? 'REFACTORING_ERROR';
  return error;
}

/**
 * List every cross-file reference to a symbol via
 * `GET /projects/:projectId/symbol-usages`. Requires project membership
 * (enforced server-side); a non-member surfaces as a thrown 403.
 *
 * @param projectId - The project to scan.
 * @param name - The section id / anchor / attribute name to find.
 * @param kind - Restrict results to ids/anchors or attributes; omit for both.
 * @returns The matching usages across the project's files.
 */
export async function findSymbolUsages(
  projectId: string,
  name: string,
  kind?: RenameSymbolKind,
): Promise<SymbolUsage[]> {
  const kindParameter = kind ? `&kind=${kind}` : '';
  const response = await fetch(
    `${API_BASE_URL}/projects/${projectId}/symbol-usages?name=${encodeURIComponent(name)}${kindParameter}`,
    { credentials: 'include' },
  );
  if (!response.ok) {
    throw refactoringError(response, await response.json().catch(() => ({})), 'Find usages failed');
  }
  const parsed: { data: { usages: SymbolUsage[] } } = await response.json();
  return parsed.data.usages;
}

/**
 * Rename a section id / anchor / attribute and update every reference to it
 * across the project via `POST /projects/:projectId/symbol-rename`.
 * Requires editor/owner (enforced server-side); a 403 or a 400 (invalid name /
 * merge conflict) surfaces as a thrown error carrying `status`/`code`.
 *
 * @param projectId - The project to refactor.
 * @param input - The symbol kind and old/new names.
 * @returns The rename outcome (files changed, occurrences rewritten, warnings).
 */
export async function renameSymbol(
  projectId: string,
  input: {
    symbolKind: RenameSymbolKind;
    oldName: string;
    newName: string;
    definitionAlreadyRenamed?: boolean;
    renamedDefinitionIsSection?: boolean;
  },
): Promise<RenameSymbolResult> {
  const response = await fetch(`${API_BASE_URL}/projects/${projectId}/symbol-rename`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    throw refactoringError(response, await response.json().catch(() => ({})), 'Rename failed');
  }
  const parsed: { data: RenameSymbolResult } = await response.json();
  return parsed.data;
}
