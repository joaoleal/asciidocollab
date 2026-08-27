import { ProjectId } from '../value-objects/ids/project-id';
import { ProjectName } from '../value-objects/project/project-name';
import { FileNodeId } from '../value-objects/ids/file-node-id';
import { Timestamps } from '../value-objects/common/timestamps';
import { isSpellcheckLanguage, type SpellcheckLanguage } from '../constants/editor-preferences';
import { ValidationError } from '../errors/common/validation-error';

/**
 * Upper bound on the stored length of {@link Project.gitIgnorePatterns}, a defensive cap on an
 *  otherwise-unbounded free-text field a project owner controls.
 */
const GIT_IGNORE_PATTERNS_MAX_LENGTH = 20_000;

/**
 * Represents an AsciiDoc collaboration project.
 *
 * A Project aggregates file tree, documents, members, and settings. It is
 * owned by a single user and may be archived to indicate it is no longer
 * actively edited. Tags are deduplicated and limited to 10 items.
 *
 * @invariant Tags are deduplicated on construction and must not exceed 10.
 * @invariant `archivedAt` must be >= `createdAt` when provided.
 */
export class Project {
  private _rootFolderId: FileNodeId | null;
  private _mainFileNodeId: FileNodeId | null;
  private _archivedAt: Date | null;
  private _timestamps: Timestamps;
  private _tags: string[];
  private _name: ProjectName;
  private _description: string | null;
  private _language: SpellcheckLanguage | null;
  private _gitIgnorePatterns: string | null;

  /**
   * @throws {Error} If tags exceed 10 items, `initialArchivedAt` precedes
   *  `createdAt`, or `initialLanguage` is not a supported language code.
   */
  constructor(
    /** Unique identifier for the project. */
    public readonly id: ProjectId,
    /** Human-readable project name. */
    name: ProjectName,
    /** Optional long-form description of the project. */
    description: string | null,
    /**
     * Categorisation tags for the project. Duplicates are removed, and the
     * resulting array must not exceed 10 items.
     */
    tags: string[],
    /**
     * Identifier of the root tree node, or null if no file tree has been
     *  initialised yet.
     */
    initialRootFolderId: FileNodeId | null,
    /** Creation and last-update timestamps. Defaults to the current time. */
    timestamps: Timestamps = new Timestamps(),
    /**
     * Timestamp of archiving, or null if the project is active. Must be >=
     *  `createdAt`.
     */
    initialArchivedAt: Date | null = null,
    /** Configured main/master AsciiDoc file, or null when unset. */
    initialMainFileNodeId: FileNodeId | null = null,
    /**
     * Document language used for spellcheck, or null when unset (the editor then
     * falls back to its default). Must be a supported language code when present.
     */
    initialLanguage: SpellcheckLanguage | null = null,
    /**
     * Maintainer-editable git-ignore patterns merged into the project's managed `.gitignore` by
     * the worker, or null when unset. Owner-gated at the use-case boundary, not here.
     */
    initialGitIgnorePatterns: string | null = null,
  ) {
    const deduplicatedTags = [...new Set(tags)];
    if (deduplicatedTags.length > 10) {
      throw new Error('Tags must not exceed 10 items');
    }

    if (initialArchivedAt !== null && timestamps.createdAt > initialArchivedAt) {
      throw new Error('archivedAt must be >= createdAt');
    }

    if (initialLanguage !== null && !isSpellcheckLanguage(initialLanguage)) {
      throw new Error(`unsupported language: ${initialLanguage}`);
    }

    this._name = name;
    this._description = description;
    this._tags = deduplicatedTags;
    this._rootFolderId = initialRootFolderId;
    this._mainFileNodeId = initialMainFileNodeId;
    this._archivedAt = initialArchivedAt;
    this._language = initialLanguage;
    this._gitIgnorePatterns = Project.normalizeGitIgnorePatterns(initialGitIgnorePatterns);
    this._timestamps = timestamps;
  }

  /**
   * Trims the value and collapses an empty/whitespace-only string to null, so "cleared" always
   * reads back as null regardless of which empty-ish value the caller passed.
   *
   * @throws {ValidationError} If the (trimmed) value exceeds {@link GIT_IGNORE_PATTERNS_MAX_LENGTH}.
   */
  private static normalizeGitIgnorePatterns(value: string | null): string | null {
    if (value === null) return null;
    const trimmed = value.trim();
    if (trimmed.length === 0) return null;
    if (trimmed.length > GIT_IGNORE_PATTERNS_MAX_LENGTH) {
      throw new ValidationError(
        `gitIgnorePatterns must not exceed ${GIT_IGNORE_PATTERNS_MAX_LENGTH} characters`,
      );
    }
    return trimmed;
  }

  /** @returns The display name of the project. */
  get name(): ProjectName {
    return this._name;
  }

  /** @returns The optional description of the project. */
  get description(): string | null {
    return this._description;
  }

  /** @returns The configured document/spellcheck language, or null when unset. */
  get language(): SpellcheckLanguage | null {
    return this._language;
  }

  /**
   * @returns The maintainer-editable git-ignore patterns merged into the project's managed
   *   `.gitignore`, or null when none are set.
   */
  get gitIgnorePatterns(): string | null {
    return this._gitIgnorePatterns;
  }

  /**
   * Sets or clears the project's maintainer-editable git-ignore patterns and bumps the update
   * timestamp. An empty or whitespace-only value is normalized to null (clears the setting).
   *
   * @param patterns - Newline-separated git-ignore pattern lines, or null to clear.
   * @throws {ValidationError} If the value exceeds the maximum stored length.
   */
  setGitIgnorePatterns(patterns: string | null): void {
    this._gitIgnorePatterns = Project.normalizeGitIgnorePatterns(patterns);
    this._timestamps = new Timestamps(this._timestamps.createdAt, new Date());
  }

  /** @returns The root folder identifier, or null if not initialised. */
  get rootFolderId(): FileNodeId | null {
    return this._rootFolderId;
  }

  /** @returns A defensive copy of the tags array. */
  get tags(): readonly string[] {
    return [...this._tags];
  }

  /** @returns The archive timestamp, or null if active. */
  get archivedAt(): Date | null {
    return this._archivedAt;
  }

  /** @returns A defensive copy of the creation date. */
  get createdAt(): Date {
    return new Date(this._timestamps.createdAt);
  }

  /** @returns A defensive copy of the last-update date. */
  get updatedAt(): Date {
    return new Date(this._timestamps.updatedAt);
  }

  /**
   * Assigns the root folder node for the project's file tree.
   * 
   * @param folderId - The file-node identifier of the root folder.
   */
  setRootFolderId(folderId: FileNodeId): void {
    this._rootFolderId = folderId;
  }

  /** @returns The configured main AsciiDoc file id, or null when unset. */
  get mainFileNodeId(): FileNodeId | null {
    return this._mainFileNodeId;
  }

  /**
   * Sets or clears the project's configured main AsciiDoc file and bumps the
   * update timestamp. Passing null clears the configuration.
   *
   * @param nodeId - The main file node id, or null to clear.
   */
  setMainFile(nodeId: FileNodeId | null): void {
    this._mainFileNodeId = nodeId;
    this._timestamps = new Timestamps(this._timestamps.createdAt, new Date());
  }

  /**
   * Marks the project as archived at the current time and bumps the update
   * timestamp.
   * 
   * @throws {Error} If the project is already archived.
   */
  archive(): void {
    if (this._archivedAt !== null) {
      throw new Error('Project is already archived');
    }
    const now = new Date();
    this._archivedAt = now;
    this._timestamps = new Timestamps(this._timestamps.createdAt, now);
  }

  /**
   * Restores an archived project by clearing the archive timestamp.
   * Bumps the update timestamp.
   * 
   * @throws {Error} If the project is not archived.
   */
  restore(): void {
    if (this._archivedAt === null) {
      throw new Error('Project is not archived');
    }
    this._archivedAt = null;
    this._timestamps = new Timestamps(this._timestamps.createdAt, new Date());
  }

  /**
   * Updates project details and bumps the update timestamp.
   * At least one field must be provided.
   *
   * @param updates - The fields to update.
   * @throws {Error} If no fields are provided or tags exceed 10 items.
   */
  update(updates: {
    name?: ProjectName;
    description?: string | null;
    tags?: string[];
    language?: string | null;
  }): void {
    if (
      updates.name === undefined &&
      updates.description === undefined &&
      updates.tags === undefined &&
      updates.language === undefined
    ) {
      throw new Error('At least one field must be provided');
    }

    if (updates.name !== undefined) {
      this._name = updates.name;
    }

    if (updates.description !== undefined) {
      this._description = updates.description;
    }

    if (updates.tags !== undefined) {
      const deduplicated = [...new Set(updates.tags)];
      if (deduplicated.length > 10) {
        throw new Error('Tags must not exceed 10 items');
      }
      this._tags = deduplicated;
    }

    if (updates.language !== undefined) {
      if (updates.language === null) {
        this._language = null;
      } else if (isSpellcheckLanguage(updates.language)) {
        this._language = updates.language;
      } else {
        throw new Error(`unsupported language: ${updates.language}`);
      }
    }

    this._timestamps = new Timestamps(this._timestamps.createdAt, new Date());
  }
}
