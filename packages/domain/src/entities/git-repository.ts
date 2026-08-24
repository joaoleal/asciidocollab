import { GitRepositoryId } from '../value-objects/ids/git-repository-id';
import { ProjectId } from '../value-objects/ids/project-id';
import { GitProvider } from '../value-objects/project/git-provider';
import { GitSyncStatus, DEFAULT_GIT_SYNC_STATUS } from '../types/git-sync-status';

/**
 * Links a project to an external Git repository for synchronisation.
 *
 * A GitRepository has a strict 1:1 relationship with a Project — each project
 * can be connected to at most one remote repository.
 */
export class GitRepository {
  /** Creates a new GitRepository link. */
  constructor(
    /** Unique identifier for this repository link. */
    public readonly id: GitRepositoryId,
    /** The project this repository link belongs to (1:1 relationship). */
    public readonly projectId: ProjectId,
    /** The Git hosting provider (e.g. GitHub, GitLab, Bitbucket). */
    public readonly provider: GitProvider,
    /** The full remote URL of the Git repository. */
    public readonly remoteUrl: string,
    /** Reference to stored credentials used for authentication. */
    public readonly credentialReference: string,
    /** The currently active branch. Defaults to `'main'`. */
    public readonly currentBranch: string = 'main',
    /** Synchronisation state relative to the remote, as last observed. Defaults to `'UP_TO_DATE'`. */
    public readonly syncStatus: GitSyncStatus = DEFAULT_GIT_SYNC_STATUS,
    /** The remote's default branch (e.g. what `HEAD` points to), or null if not yet known. */
    public readonly defaultBranch: string | null = null,
    /** The last remote commit hash observed for `currentBranch`, or null if not yet known. */
    public readonly lastKnownRemoteHead: string | null = null,
    /**
     * Timestamp of the last successful synchronisation, or null if never
     *  synced.
     */
    public readonly lastSyncAt: Date | null = null,
    /**
     * Timestamp when the repository link was created. Defaults to the current
     *  time.
     */
    public readonly createdAt: Date = new Date(),
  ) {}
}
