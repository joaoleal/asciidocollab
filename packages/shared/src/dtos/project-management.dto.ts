/**
 * DTO for listing user projects response.
 */
export interface ListUserProjectsResultDto {
  /** List of projects for the current page. */
  projects: ProjectDto[];
  /** Total number of matching projects. */
  total: number;
  /** Current page number. */
  page: number;
  /** Number of items per page. */
  limit: number;
  /** Total number of pages. */
  totalPages: number;
}

/**
 * DTO for updating a project request.
 */
export interface UpdateProjectDto {
  /** New project name. */
  name?: string;
  /** New project description. */
  description?: string | null;
  /** New project tags. */
  tags?: string[];
  /** New document/spellcheck language (ISO 639-1), or null to clear it. */
  language?: string | null;
}

/**
 * DTO for archiving a project response.
 */
export interface ArchiveProjectResultDto {
  /** Unique project identifier. */
  id: string;
  /** Archive timestamp. */
  archivedAt: string;
}

/**
 * DTO for restoring a project response.
 */
export interface RestoreProjectResultDto {
  /** Unique project identifier. */
  id: string;
  /** Always null after restore. */
  archivedAt: null;
}

/**
 * DTO for project data.
 */
export interface ProjectDto {
  /** Unique project identifier. */
  id: string;
  /** Display name of the project. */
  name: string;
  /** Optional project description. */
  description: string | null;
  /** Users with the owner role on this project. */
  owners: { userId: string; displayName: string }[];
  /** Categorization tags. */
  tags: string[];
  /** Root folder identifier. */
  rootFolderId: string | null;
  /** Configured main AsciiDoc file node id; null ⇒ current-file-only resolution. */
  mainFileNodeId: string | null;
  /** Document/spellcheck language (ISO 639-1); null ⇒ editor uses its default. */
  language: string | null;
  /** Archive timestamp, null if not archived. */
  archivedAt: string | null;
  /** Number of project members. */
  memberCount?: number;
  /** Number of files (not folders) in the project. */
  fileCount?: number;
  /** Current user's role in the project. */
  role?: 'viewer' | 'editor' | 'owner';
  /** Creation timestamp. */
  createdAt: string;
  /** Last update timestamp. */
  updatedAt: string;
}
