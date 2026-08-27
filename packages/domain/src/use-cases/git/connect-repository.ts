import { randomUUID } from 'crypto';
import { UserId } from '../../value-objects/ids/user-id';
import { ProjectId } from '../../value-objects/ids/project-id';
import { GitRepositoryId } from '../../value-objects/ids/git-repository-id';
import { GitProvider } from '../../value-objects/project/git-provider';
import { GitRepository } from '../../entities/git-repository';
import { GitRepositoryRepository } from '../../ports/project/git-repository.repository';
import { GitCredentialStore } from '../../ports/git/git-credential-store';
import { GitReadPort } from '../../ports/git/git-command-runner';
import { GitOperationRepository } from '../../ports/git/git-operation-repository';
import { ProjectMemberRepository } from '../../ports/project/project-member.repository';
import { AuditLogRepository } from '../../ports/admin/audit-log.repository';
import { Logger } from '../../ports/observability/logger';
import { DomainError } from '../../errors/domain-error';
import { ValidationError } from '../../errors/common/validation-error';
import { RepositoryAlreadyConnectedError } from '../../errors/git/repository-already-connected';
// Referenced only from this file's own JSDoc @link tags (never thrown directly here) — each is
// raised inside GitCommandRunner.checkRemoteAccess, GitOperationRepository.withGuard, or
// requireGitRole; kept imported so the links resolve to real symbols.
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- doc-only reference, see comment above.
import type { RepositoryUnreachableError } from '../../errors/git/repository-unreachable';
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- doc-only reference, see comment above.
import type { AuthenticationFailedError } from '../../errors/git/authentication-failed';
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- doc-only reference, see comment above.
import type { GitOperationInProgressError } from '../../errors/git/git-operation-in-progress';
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- doc-only reference, see comment above.
import type { InsufficientRoleError } from '../../errors/git/insufficient-role';
import { requireGitRole } from './git-role-guard';
import { Result } from '../../types/result';
import { RequestContext } from '../../types/request-context';
import { recordAuditSuccess } from '../audit-recording';
import { AUDIT_GIT_REPOSITORY_CONNECTED } from '../../audit-actions';

/**
 * A remote URL this use case will accept: either an `http(s)://` URL or a scp-style
 * `git@host:path` reference, neither containing whitespace or the shell metacharacters
 * (`;`, `|`, `&`, backticks, `$(`) an argument-injection attempt against the eventual `git`
 * invocation would need. This is a defense-in-depth check at the domain boundary — the Fastify
 * route schema and the git-worker runner each validate independently before the value reaches
 * an actual `git` process (data-model.md).
 */
const VALID_REMOTE_URL_PATTERN = /^(?:https?:\/\/|git@)[^\s;|&`$]+$/;

/** Everything `ConnectRepositoryUseCase.execute` needs to connect a project to a remote. */
export interface ConnectRepositoryInput {
  /** The user asking to connect the repository. Must be the project's OWNER. */
  readonly actorId: UserId;
  /** The project to connect. */
  readonly projectId: ProjectId;
  /** The git hosting provider, e.g. `'github'`, `'gitlab'`, or `'bitbucket'`. */
  readonly provider: string;
  /** The remote repository's URL. */
  readonly remoteUrl: string;
  /** The plaintext access token to authenticate with. Encrypted before storage, never persisted as-is. */
  readonly token: string;
  /** The branch to check out initially. Defaults to `'main'` when omitted. */
  readonly branch?: string;
  /** Request origin, captured into audit metadata. */
  readonly context?: RequestContext;
}

/** What a successful connection hands back to its caller. */
export interface ConnectRepositoryResult {
  /** The newly created repository link. */
  readonly repository: GitRepository;
}

/**
 * Connects a project to an external Git remote: validates the provider and remote URL,
 * authenticates against the remote, stores the encrypted access credential, and creates the
 * project's `GitRepository` link.
 *
 * OWNER-gated (data-model.md's git authorization matrix) — connecting a remote grants every future
 * collaborator with EDITOR access the ability to push under this credential, so only the
 * project's OWNER may establish it.
 */
export class ConnectRepositoryUseCase {
  /**
   * @param gitRepositoryRepo - Persists the project's `GitRepository` link.
   * @param credentialStore - Encrypts and persists the access credential; takes the plaintext
   *   token and never hands it back.
   * @param commandRunner - Runs the connectivity/authentication check against the remote.
   * @param gitOperationRepo - Single-flight guard so a connect cannot race another git action.
   * @param projectMemberRepo - Resolves the actor's role for the authorization check.
   * @param auditLogRepo - Records the authorization denial and the successful connection.
   * @param logger - Optional sink for best-effort audit-write failures.
   */
  constructor(
    private readonly gitRepositoryRepo: GitRepositoryRepository,
    private readonly credentialStore: GitCredentialStore,
    private readonly commandRunner: GitReadPort,
    private readonly gitOperationRepo: GitOperationRepository,
    private readonly projectMemberRepo: ProjectMemberRepository,
    private readonly auditLogRepo: AuditLogRepository,
    private readonly logger?: Logger,
  ) {}

  /**
   * Connects the project to the given remote.
   *
   * @param input - The acting user, the project, and the remote/credential to connect.
   * @returns The created repository link on success; a typed refusal otherwise —
   *   {@link InsufficientRoleError} when the actor is not the project's OWNER, a
   *   {@link ValidationError} for an unrecognized provider or malformed remote URL,
   *   {@link RepositoryAlreadyConnectedError} when the project already has a repository link,
   *   {@link RepositoryUnreachableError}/{@link AuthenticationFailedError} when the remote check
   *   fails, or {@link GitOperationInProgressError} when another git action is already in flight
   *   for this project.
   */
  async execute(
    input: ConnectRepositoryInput,
  ): Promise<Result<ConnectRepositoryResult, DomainError>> {
    const roleCheck = await requireGitRole(
      this.projectMemberRepo,
      this.auditLogRepo,
      {
        actorId: input.actorId,
        projectId: input.projectId,
        requiredRole: 'owner',
        context: input.context,
      },
      this.logger,
    );
    if (!roleCheck.success) return roleCheck;

    let provider: GitProvider;
    try {
      provider = GitProvider.create(input.provider);
    } catch (error) {
      if (error instanceof DomainError) return { success: false, error };
      throw error;
    }

    if (!VALID_REMOTE_URL_PATTERN.test(input.remoteUrl)) {
      return {
        success: false,
        error: new ValidationError(`Invalid Git remote URL: ${input.remoteUrl}`),
      };
    }

    // Checked here, ahead of the remote/storage work, so a reconnect attempt on an
    // already-connected project is a typed refusal rather than a storage-layer unique-constraint
    // error surfacing from `gitRepositoryRepo.save` (the entity's 1:1 relationship with a project).
    const existing = await this.gitRepositoryRepo.findByProjectId(input.projectId);
    if (existing !== null) {
      return { success: false, error: new RepositoryAlreadyConnectedError() };
    }

    const guarded = await this.gitOperationRepo.withGuard(input.projectId, () =>
      this.connectWhileGuarded(input, provider),
    );
    // `withGuard` wraps the inner Result in its own Result (its failure is
    // `GitOperationInProgressError`, a peer of the inner step's own refusals) — unwrap so callers
    // see one flat Result regardless of which layer refused.
    return guarded.success ? guarded.value : guarded;
  }

  /**
   * Runs the remote check and, on success, stores the credential and creates the repository
   * link — the part of the flow held under the project's single-flight guard.
   */
  private async connectWhileGuarded(
    input: ConnectRepositoryInput,
    provider: GitProvider,
  ): Promise<Result<ConnectRepositoryResult, DomainError>> {
    const accessCheck = await this.commandRunner.checkRemoteAccess({
      remoteUrl: input.remoteUrl,
      token: input.token,
    });
    if (!accessCheck.success) return accessCheck;

    // The store encrypts this internally and derives its own display hint — the plaintext
    // token is never held here beyond this call, and never appears in what gets persisted.
    await this.credentialStore.save(input.projectId, {
      token: input.token,
      provider,
      createdByUserId: input.actorId,
    });

    const repository = new GitRepository(
      GitRepositoryId.create(randomUUID()),
      input.projectId,
      provider,
      input.remoteUrl,
      // The credential store is keyed by projectId (one credential per project), so the
      // project id itself is the reference the repository link needs to find it back.
      input.projectId.value,
      input.branch ?? 'main',
      // syncStatus, defaultBranch, and lastKnownRemoteHead all take their entity defaults: a
      // freshly connected repository starts UP_TO_DATE with neither observed yet.
      undefined,
      undefined,
      undefined,
      null,
      new Date(),
      input.actorId,
    );
    // The credential is already persisted; if the link save now fails (DB error / constraint),
    // a naive return would leave the project with stored credential material and no repository
    // row — connected in secret storage, unconnected everywhere else. Roll the credential back
    // best-effort so a failed connect leaves nothing behind, then rethrow the ORIGINAL failure.
    try {
      await this.gitRepositoryRepo.save(repository);
    } catch (saveError) {
      await this.rollbackCredential(input.projectId);
      throw saveError;
    }

    await recordAuditSuccess(
      this.auditLogRepo,
      {
        actorId: input.actorId,
        projectId: input.projectId,
        action: AUDIT_GIT_REPOSITORY_CONNECTED,
        resourceType: 'GitRepository',
        resourceId: repository.id.value,
        metadata: { provider: provider.value },
        context: input.context,
      },
      this.logger,
    );

    return { success: true, value: { repository } };
  }

  /**
   * Best-effort removal of a just-saved credential after the repository link failed to persist,
   * so a failed connect never orphans credential material. A failure here is itself swallowed and
   * logged — it must never mask the original link-save error the caller is about to rethrow. The
   * log carries no credential material: only the fact that the compensating delete failed.
   */
  private async rollbackCredential(projectId: ProjectId): Promise<void> {
    try {
      await this.credentialStore.delete(projectId);
    } catch (rollbackError) {
      this.logger?.warn('Failed to roll back stored Git credential after a failed connect', {
        error: rollbackError,
        projectId: projectId.value,
      });
    }
  }
}
