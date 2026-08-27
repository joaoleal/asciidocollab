import { GitRepository } from '../../entities/git-repository';
import { GitRepositoryId } from '../../value-objects/ids/git-repository-id';
import { ProjectId } from '../../value-objects/ids/project-id';
import { GitSyncStatus } from '../../types/git-sync-status';

/**
 * The exact set of columns a remote-status refresh observes and is allowed to write back — the
 * derived sync status plus the fetched remote head and the moment it was observed. Deliberately does
 * NOT include `currentBranch`, `remoteUrl`, `credentialReference`, `provider`, or `defaultBranch`:
 * a refresh's multi-second `git fetch` can overlap a user action (a branch switch, a credential
 * rotation) that legitimately changes those, and writing back a whole stale in-memory snapshot would
 * silently revert that concurrent change. Passing only these fields makes the narrow write the type
 * enforces, not merely a convention.
 */
export interface RefreshedSyncStatusFields {
  /** The project whose repository row to update (its unique key). */
  readonly projectId: ProjectId;
  /** The status to write — the derived status, or `CONFLICTED` when the refresh preserves a conflict. */
  readonly syncStatus: GitSyncStatus;
  /**
   * The `syncStatus` the refresh OBSERVED when it loaded the row before its fetch — the
   * optimistic-concurrency guard for a `CONFLICTED` write. Preserving a conflict means re-asserting
   * `CONFLICTED`, but only if the row still holds the observed status: a concurrent resolve (e.g. a
   * `complete-merge` that moved the row `CONFLICTED` → `UP_TO_DATE` during the multi-second fetch)
   * changes it away, so the re-assert must find no matching row and be dropped rather than stomp the
   * resolved row back to `CONFLICTED`. Only consulted for a `CONFLICTED` write; a non-`CONFLICTED`
   * write is guarded solely by "row is not `CONFLICTED`", independent of this value.
   */
  readonly expectedCurrentStatus: GitSyncStatus;
  /** The tip of the remote-tracking ref observed by the fetch. */
  readonly lastKnownRemoteHead: string | null;
  /** When this refresh observed the remote. */
  readonly lastSyncAt: Date | null;
}

/**
 * Repository interface for managing GitRepository persistence.
 * Handles storage and retrieval of remote Git repository configurations per project.
 */
export interface GitRepositoryRepository {
  /**
   * Finds a git repository configuration by its unique identifier.
   * 
   * @param id - The unique identifier of the git repository.
   * @returns The git repository if found, null otherwise.
   */
  findById(id: GitRepositoryId): Promise<GitRepository | null>;

  /**
   * Finds a git repository configuration associated with a project.
   * 
   * @param projectId - The unique identifier of the project.
   * @returns The git repository if found, null otherwise.
   */
  findByProjectId(projectId: ProjectId): Promise<GitRepository | null>;

  /**
   * Lists every connected git repository across all projects — the set a background remote-status
   * sweep iterates over. Rows whose `syncStatus` is `DISCONNECTED` are excluded: an initialize
   * persists such a placeholder before it publishes to the remote, and a failed or in-progress
   * initialize leaves one behind, so it is not yet a repository a sweep should fetch. Rows whose
   * `syncStatus` is `NEEDS_REAUTH` are excluded too: their stored credential was rejected by the
   * remote, so they must not be swept until the credential is rotated.
   *
   * @returns Every connected git repository; an empty array when none are connected.
   */
  findAllConnected(): Promise<GitRepository[]>;

  /**
   * Persists a git repository entity (create or update).
   *
   * @param gitRepository - The git repository entity to save.
   * @returns A promise that resolves when the operation completes.
   */
  save(gitRepository: GitRepository): Promise<void>;

  /**
   * Persists a refresh's observed sync fields (status, remote head, last-sync time), but NEVER
   * overwrites a currently stored `CONFLICTED` status with a non-`CONFLICTED` one. This closes the
   * race where a concurrent pull marks the row `CONFLICTED` between a background refresh's load and
   * its write: the refresh's derived (non-conflicted) status must not silently clear that conflict.
   *
   * The guard is conditional on the *stored* status at write time, so it must be atomic where the
   * backing store supports it (e.g. A conditional `updateMany ... WHERE syncStatus <> 'CONFLICTED'`).
   * When the refresh itself is preserving `CONFLICTED` (the loaded row was already conflicted), the
   * observed fields are still written and the status stays `CONFLICTED` — but only if the row still
   * holds {@link RefreshedSyncStatusFields.expectedCurrentStatus} (the status the refresh observed):
   * a concurrent resolve (e.g. a `complete-merge` that cleared the conflict during the fetch) moves
   * the row off that status, so the re-assert matches no row and is dropped rather than stomping the
   * resolved row back to `CONFLICTED`. A non-conflicted write is blocked against a stored conflict.
   *
   * Scoped to {@link RefreshedSyncStatusFields}, NOT a whole `GitRepository`: it writes ONLY
   * `syncStatus`, `lastKnownRemoteHead`, and `lastSyncAt`. Every other mutable column
   * (`currentBranch`, `remoteUrl`, `credentialReference`, `provider`, `defaultBranch`) is left
   * exactly as stored, so a concurrent user action that changed one of them during the refresh's
   * fetch is never reverted by this write.
   *
   * @param fields - The observed sync fields to persist (identified by `projectId`).
   * @returns `true` when the observed fields were written; `false` when the conditional write
   *   matched no row. A `false` result conflates two distinct races and cannot tell them apart: a
   *   stored `CONFLICTED` status blocked a non-conflicted write, OR the project has no repository
   *   row (it was disconnected/deleted during the refresh). It tells the caller only that its
   *   derived status was NOT persisted; the caller must re-read the row to decide which race
   *   occurred — reporting `CONFLICTED` only when a conflicted row still exists, and the derived
   *   status when the row is gone.
   */
  saveRefreshedStatus(fields: RefreshedSyncStatusFields): Promise<boolean>;

  /**
   * Marks the project's repository row `NEEDS_REAUTH` — used when the remote rejects the stored
   * credential — but ONLY when its currently stored `syncStatus` is not `CONFLICTED`: an unresolved
   * merge conflict the user must resolve outranks a re-auth prompt, so this must never clear one.
   * Touches no column other than `syncStatus`. Never inserts — a project with no repository row (it
   * was disconnected/deleted between the caller's earlier load and this write) is left absent, not
   * recreated from a stale snapshot.
   *
   * The guard is conditional on the *stored* status at write time, so it must be atomic where the
   * backing store supports it (e.g. a conditional `updateMany ... WHERE syncStatus <> 'CONFLICTED'`),
   * mirroring {@link saveRefreshedStatus}.
   *
   * @param projectId - The project whose repository row to mark.
   * @returns `true` when the row was updated; `false` when the row is gone or was `CONFLICTED`.
   */
  markNeedsReauthUnlessConflicted(projectId: ProjectId): Promise<boolean>;

  /**
   * Removes a git repository configuration by its unique identifier.
   * 
   * @param id - The unique identifier of the git repository to delete.
   * @returns A promise that resolves when the operation completes.
   */
  delete(id: GitRepositoryId): Promise<void>;
}
