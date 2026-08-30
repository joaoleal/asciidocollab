import { readFileSync } from 'node:fs';
import pino from 'pino';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import {
  GetGitStatusUseCase,
  GetBehindAheadUseCase,
  StageChangesUseCase,
  CommitChangesUseCase,
  GetBranchesUseCase,
  CreateBranchUseCase,
  CompleteMergeUseCase,
  UndoPullUseCase,
  ListConflictsUseCase,
  GetConflictStagesUseCase,
  ResolveConflictsUseCase,
  GitChangeReconciler,
  GetHistoryUseCase,
  GetDiffUseCase,
  GetBlameUseCase,
  DiscardChangesUseCase,
  AmendCommitUseCase,
  ProjectId,
  UserId,
  type Logger,
  type GetGitStatusResult,
  type GitBehindAhead,
  type GitDiffResult,
  type StageChangesResult,
  type CommitChangesResult,
  type GetBranchesResult,
  type CreateBranchResult,
  type GetConflictStagesResult,
  type ResolveConflictsResult,
  type ConflictResolution,
  type DiscardChangesResult,
  type AmendCommitResult,
  type DomainError,
  type Result,
} from '@asciidocollab/domain';
import {
  PrismaGitOperationRepository,
  PrismaGitCredentialStore,
  PrismaAuditLogRepository,
  PrismaProjectRepository,
  PrismaFileNodeRepository,
  PrismaDocumentRepository,
  PrismaAssetRepository,
  PrismaGitRepositoryRepository,
  PrismaProjectMemberRepository,
  PrismaCollaborationSessionRepository,
  PrismaUserRepository,
  PrismaEditorPreferencesRepository,
  FilesystemProjectFileStore,
  HttpCollaborativeContentEditor,
  SessionEncryption,
} from '@asciidocollab/infrastructure';
import type {
  CompleteMergeWireResult,
  UndoPullWireResult,
  ListConflictsWireResult,
  GetHistoryWireResult,
  GetBlameWireResult,
} from './internal-git-server.js';
import { createGitWorkerConfig } from './config/git-worker-config.js';
import { RealGitCommandRunner } from './git/git-command-runner.js';
import { FilesystemConflictStageStore } from './git/filesystem-conflict-stage-store.js';
import { ensureCleanWorkingTree, resolveWorkingTreePath } from './git/working-tree.js';
import { createGitWorkerLoop, type GitWorkerLoop } from './worker-loop.js';
import { createRemoteRefreshScheduler, type RemoteRefreshScheduler } from './remote-refresh-scheduler.js';
import { createUndoReferenceSweeper } from './undo-reference-sweeper.js';
import { createImportHandler } from './dispatch/import-handler.js';
import { createInitializeHandler } from './dispatch/initialize-handler.js';
import { createPushHandler } from './dispatch/push-handler.js';
import { createPullHandler } from './dispatch/pull-handler.js';
import { createSwitchBranchHandler } from './dispatch/switch-branch-handler.js';
import { createFetchHandler } from './dispatch/fetch-handler.js';
import type { GitOperationHandlerRegistry } from './dispatch/git-operation-dispatcher.js';
import { mapHistoryCommitsToWire, mapOperationId } from './git-wire-mappers.js';
import {
  createConnectOpFunction,
  createPreviewPullOpFunction,
  createPreviewPushOpFunction,
} from './internal-git-op-functions.js';

// Re-exported so `composition-root.test.ts` (and any future caller) can keep resolving these op-fn
// adapters and their deps shapes from this module, even though the factories themselves now live in
// the co-located `internal-git-op-functions.ts` alongside the other op-fn adapters.
export {
  createConnectOpFunction,
  createPreviewPullOpFunction,
  createPreviewPushOpFunction,
} from './internal-git-op-functions.js';
export type {
  ConnectOpDeps,
  PreviewPullCredentialSource,
  PreviewPullOpDeps,
  PreviewPushOpDeps,
} from './internal-git-op-functions.js';

/**
 * The wired git-worker application. `src/index.ts` drives its lifecycle: construct via
 * {@link compositionRoot}, `start()` it, then `shutdown()` it on SIGTERM/SIGINT. The pure
 * domain-to-wire mappers this root's op fns serialize with live in `git-wire-mappers.ts`; the
 * connect/preview-pull/preview-push op-fn adapters compositionRoot() below builds from live in
 * `internal-git-op-functions.ts`.
 */

/** The running git-worker process: its start/stop lifecycle. */
export interface GitWorkerApp {
  /**
   * Starts the git-worker application: begins the poll/claim/dispatch run loop.
   *
   * @returns Resolves once startup completes.
   */
  start(): Promise<void>;
  /**
   * Shuts down the git-worker application: stops the run loop, waiting for its current
   * iteration — including an in-flight claimed job — to finish, then closes the database
   * connection.
   *
   * @returns Resolves once shutdown completes.
   */
  shutdown(): Promise<void>;
  /**
   * Reports whether the application is currently started.
   *
   * @returns True once `start()` has resolved and until `shutdown()` resolves.
   */
  isRunning(): boolean;
}

/**
 * Wires up the git-worker application: constructs the real adapters (`GitOperationRepository`,
 * `GitCredentialStore`, `GitCommandRunner`, `AuditLogRepository`, and the persistence stack each
 * registered use-case handler needs) from config, and the run loop that polls/claims
 * `GitOperation` work, dispatches it, and records its outcome.
 *
 * `IMPORT`, `INITIALIZE`, `PUSH`, `PULL`, `BRANCH_SWITCH`, and `FETCH` (the background remote
 * refresh) are the `GitOperationKind`s with a registered handler so far — every
 * other kind is still a future story task's job (YAGNI). Until a story task registers one, a claimed operation
 * of an unregistered kind dispatches to the `UNHANDLED_GIT_OPERATION_KIND` failure path (see
 * `dispatch/git-operation-dispatcher.ts`), so it always reaches a terminal state — and releases
 * the single-flight lock it holds — rather than hanging forever. `gitCredentialStore` and
 * `gitCommandRunner` are already constructed here, ready for those future handlers to close over
 * too. Likewise, `writeManagedGitignore` (`git/managed-gitignore.ts`) is ready for a future
 * init/commit handler to call — after `ensureCleanWorkingTree`, with the project's current
 * `gitIgnorePatterns` — so the managed `.gitignore` (and its merged owner-set patterns) stays
 * current on every job.
 *
 * @returns The composed application, ready to start. Structurally satisfies `GitWorkerApp` plus a
 *   few extra fields (below) exposed for tests and future use-case wiring — no explicit
 *   `Promise<GitWorkerApp>` return type is declared so those extras aren't excess-property-checked
 *   away.
 */
export async function compositionRoot() {
  const logger = pino();
  const config = createGitWorkerConfig();
  config.validate({ allowed: 'strict' });

  const prisma = new PrismaClient({ adapter: new PrismaPg(config.get('databaseUrl')) });

  const gitOperationRepository = new PrismaGitOperationRepository(prisma);
  const auditLogRepository = new PrismaAuditLogRepository(prisma);
  const credentialEncryption = new SessionEncryption({ encryptionKey: config.get('credentialEncryptionKey') });
  // gitCredentialStore.loadDecrypted() is the IMPORT handler's execution-time credential source
  // (below); gitCommandRunner is likewise reused there, and both stay constructed here for future
  // handlers to close over too.
  const gitCredentialStore = new PrismaGitCredentialStore(prisma, credentialEncryption);
  const storageRoot = config.get('storageRoot');
  // Off-working-tree store for captured conflict stages and pre-operation undo snapshots — rooted
  // outside every project's working tree (never under storageRoot) so ensureCleanWorkingTree's
  // `git clean -fdx` can never delete it while a conflict awaits resolution.
  const conflictStageStore = new FilesystemConflictStageStore(config.get('conflictStoreRoot'));
  const gitCommandRunner = new RealGitCommandRunner(
    storageRoot,
    config.get('egressAllowedHosts'),
    undefined,
    conflictStageStore,
    config.get('maxRepoSizeMB'),
    config.get('lfsThresholdBytes'),
  );

  // Adapts this app's structured pino logger to the domain's minimal `Logger` port (best-effort
  // `warn`-only sink), the same shape apps/api's `requestLogger` adapter presents.
  const useCaseLogger: Logger = {
    warn: (message, meta) => logger.warn(meta ?? {}, message),
  };

  // Hoisted so both the IMPORT handler (below) and the short-op use cases (status/stage/commit)
  // share one instance each, rather than each constructing its own redundant Prisma wrapper.
  // `assetRepository` and `fileStore` are also shared with the PULL handler's `GitChangeReconciler`
  // below, for the same reason.
  const fileNodeRepository = new PrismaFileNodeRepository(prisma);
  const documentRepository = new PrismaDocumentRepository(prisma);
  const assetRepository = new PrismaAssetRepository(prisma);
  // The CONTENT-BYTES projection path — deliberately `contentStorageRoot`, NOT `storageRoot`
  // (that root is this worker's own git working-tree directory). See
  // `config/git-worker-config.ts`'s docs on why the two must never be conflated.
  const fileStore = new FilesystemProjectFileStore(config.get('contentStorageRoot'));
  const gitRepositoryRepository = new PrismaGitRepositoryRepository(prisma);
  const projectMemberRepository = new PrismaProjectMemberRepository(prisma);

  // Hoisted above the handlers map (moved up from beside the short-op use cases below) so the
  // PULL handler's `PullChangesUseCase`/`GitChangeReconciler` can share these same instances too.
  // `CommitChangesUseCase` (below) needs a live read of each staged open document's current
  // collaborative text before it commits; `HttpCollaborativeContentEditor` (the same adapter
  // apps/api's DI container builds — `apps/api/src/di/stores.ts`) implements both the editor and
  // reader ports, so it is constructed here and passed as the reader everywhere one is needed.
  const collaborationSessionRepository = new PrismaCollaborationSessionRepository(prisma);
  const collabEditTls = config.get('collab.editTls');
  const useCollabEditMtls = Boolean(collabEditTls.cert && collabEditTls.key && collabEditTls.ca);
  const collaborativeContentReader = new HttpCollaborativeContentEditor({
    baseUrl: config.get('collab.editUrl'),
    ...(config.get('collab.editSecret') ? { secret: config.get('collab.editSecret') } : {}),
    ...(useCollabEditMtls
      ? {
          tls: {
            cert: readFileSync(collabEditTls.cert),
            key: readFileSync(collabEditTls.key),
            ca: readFileSync(collabEditTls.ca),
          },
        }
      : {}),
  });

  // Lands a clean PULL merge's change-set into the project — reuses the exact per-file
  // construction the IMPORT flow uses (id minting, path normalization, AsciiDoc/theme-versus-asset
  // classification), so a file that arrives through a pull is indistinguishable from one that
  // arrived through the original import. `HttpCollaborativeContentEditor` implements the writer
  // port too, so the same `collaborativeContentReader` instance is passed as the writer.
  const gitChangeReconciler = new GitChangeReconciler(
    fileNodeRepository,
    documentRepository,
    assetRepository,
    fileStore,
    collaborationSessionRepository,
    collaborativeContentReader,
    useCaseLogger,
  );

  const handlers: GitOperationHandlerRegistry = {
    IMPORT: createImportHandler({
      projectRepository: new PrismaProjectRepository(prisma),
      fileNodeRepository,
      documentRepository,
      assetRepository,
      fileStore,
      gitRepositoryRepository,
      commandRunner: gitCommandRunner,
      projectMemberRepository,
      auditLogRepository,
      credentialSource: gitCredentialStore,
      logger: useCaseLogger,
    }),
    INITIALIZE: createInitializeHandler({
      gitRepositoryRepository,
      commandRunner: gitCommandRunner,
      gitOperationRepository,
      projectMemberRepository,
      auditLogRepository,
      credentialSource: gitCredentialStore,
      logger: useCaseLogger,
    }),
    PUSH: createPushHandler({
      projectMemberRepository,
      auditLogRepository,
      gitRepositoryRepository,
      commandRunner: gitCommandRunner,
      credentialSource: gitCredentialStore,
      logger: useCaseLogger,
    }),
    PULL: createPullHandler({
      projectMemberRepository,
      auditLogRepository,
      gitRepositoryRepository,
      gitOperationRepository,
      commandRunner: gitCommandRunner,
      fileNodeRepository,
      documentRepository,
      collaborativeContentReader,
      collaborationSessionRepository,
      reconciler: gitChangeReconciler,
      credentialSource: gitCredentialStore,
      logger: useCaseLogger,
    }),
    BRANCH_SWITCH: createSwitchBranchHandler({
      projectMemberRepository,
      auditLogRepository,
      gitRepositoryRepository,
      gitOperationRepository,
      commandRunner: gitCommandRunner,
      fileNodeRepository,
      documentRepository,
      collaborativeContentReader,
      collaborationSessionRepository,
      reconciler: gitChangeReconciler,
      logger: useCaseLogger,
    }),
    // The background remote-refresh scheduler (below) enqueues a FETCH per connected repo; this
    // handler runs the refs-only refresh when the run loop claims it, so the fetch is serialized
    // against user pull/push/switch through the same single-flight queue rather than racing them.
    FETCH: createFetchHandler({
      gitRepositoryRepository,
      commandRunner: gitCommandRunner,
      credentialSource: gitCredentialStore,
      logger: useCaseLogger,
    }),
  };

  // The short git ops (status/behind-ahead/stage/unstage/commit) run synchronously, worker-side, through the
  // internal RPC server `src/index.ts` starts once this composition root resolves — see that
  // file for the `startInternalGitServer` call.
  const userRepository = new PrismaUserRepository(prisma);
  // Commit/amend consult this to resolve whether the author has opted into a privacy-preserving
  // commit email (see `resolveCommitAuthorEmail` in the domain package).
  const editorPreferencesRepository = new PrismaEditorPreferencesRepository(prisma);

  const getGitStatusUseCase = new GetGitStatusUseCase(gitRepositoryRepository, gitCommandRunner, useCaseLogger);
  const getBehindAheadUseCase = new GetBehindAheadUseCase(gitRepositoryRepository, gitCommandRunner, useCaseLogger);
  const stageChangesUseCase = new StageChangesUseCase(
    projectMemberRepository,
    auditLogRepository,
    gitRepositoryRepository,
    gitOperationRepository,
    gitCommandRunner,
    useCaseLogger,
  );
  const commitChangesUseCase = new CommitChangesUseCase(
    projectMemberRepository,
    auditLogRepository,
    gitRepositoryRepository,
    gitOperationRepository,
    gitCommandRunner,
    fileNodeRepository,
    documentRepository,
    collaborativeContentReader,
    collaborationSessionRepository,
    userRepository,
    editorPreferencesRepository,
    useCaseLogger,
  );
  // Connect (attaching an existing project to an already-existing remote — no clone, no push) runs
  // SYNC over this same internal RPC seam: it must run here rather than being enqueued because it
  // calls `checkRemoteAccess` (`git ls-remote`) against the real `GitCommandRunner`, exactly like
  // status/commit above.
  const connect = createConnectOpFunction({
    gitRepositoryRepository,
    gitCredentialStore,
    gitCommandRunner,
    gitOperationRepository,
    projectMemberRepository,
    auditLogRepository,
    logger: useCaseLogger,
  });
  const getBranchesUseCase = new GetBranchesUseCase(gitRepositoryRepository, gitCommandRunner, useCaseLogger);
  const createBranchUseCase = new CreateBranchUseCase(
    projectMemberRepository,
    auditLogRepository,
    gitRepositoryRepository,
    gitCommandRunner,
    useCaseLogger,
  );
  // Complete/undo run SYNC over this same internal RPC seam, operating on the project's EXISTING
  // awaiting/most-recent operation rather than enqueuing a new one — see the composition below.
  const completeMergeUseCase = new CompleteMergeUseCase(
    projectMemberRepository,
    auditLogRepository,
    gitRepositoryRepository,
    gitOperationRepository,
    gitCommandRunner,
    conflictStageStore,
    gitChangeReconciler,
    useCaseLogger,
  );
  const undoPullUseCase = new UndoPullUseCase(
    projectMemberRepository,
    auditLogRepository,
    gitRepositoryRepository,
    gitOperationRepository,
    gitCommandRunner,
    conflictStageStore,
    gitChangeReconciler,
    useCaseLogger,
  );
  // The three conflict read/resolve ops likewise run SYNC over this same internal RPC seam,
  // reading/editing the project's EXISTING awaiting operation's `GitConflict` rows rather than
  // enqueuing new work.
  const listConflictsUseCase = new ListConflictsUseCase(gitOperationRepository);
  const getConflictStagesUseCase = new GetConflictStagesUseCase(gitOperationRepository, conflictStageStore);
  const resolveConflictsUseCase = new ResolveConflictsUseCase(
    projectMemberRepository,
    auditLogRepository,
    gitOperationRepository,
    conflictStageStore,
    useCaseLogger,
  );

  // The three read-only history/diff/blame ops likewise run SYNC over this same internal RPC seam
  // (a local git-log/diff/blame read, not a mutating action) — no single-flight guard, and no
  // domain-level role check: the calling route's own VIEWER-tier membership gate is the check.
  const getHistoryUseCase = new GetHistoryUseCase(gitRepositoryRepository, gitCommandRunner, userRepository, useCaseLogger);
  const getDiffUseCase = new GetDiffUseCase(
    gitRepositoryRepository,
    gitCommandRunner,
    fileNodeRepository,
    documentRepository,
    collaborationSessionRepository,
    collaborativeContentReader,
    useCaseLogger,
  );
  const getBlameUseCase = new GetBlameUseCase(gitRepositoryRepository, gitCommandRunner, userRepository, useCaseLogger);

  // Unlike history/diff/blame, the pull/push previews DO self-gate role (EDITOR) inside their own
  // use case, the same tier PullChangesUseCase/PushChangesUseCase require — a pull preview's live
  // fetch authenticates with the project's stored credential exactly like a real pull, so this is
  // not a plain read-only check every project member may run. previewPull additionally decrypts the
  // stored credential here (mirroring the PULL/PUSH dispatch handlers' own `credentialSource`), since
  // a sync RPC op fn has no separate dispatch-handler layer to do that ahead of time.
  const previewPull = createPreviewPullOpFunction({
    projectMemberRepository,
    auditLogRepository,
    gitRepositoryRepository,
    gitCommandRunner,
    userRepository,
    gitCredentialStore,
    logger: useCaseLogger,
  });
  const previewPush = createPreviewPushOpFunction({
    projectMemberRepository,
    auditLogRepository,
    gitRepositoryRepository,
    gitCommandRunner,
    userRepository,
    logger: useCaseLogger,
  });

  // Discard/restore and amend likewise run SYNC over this same internal RPC seam — both are
  // whole-project mutating git actions (EDITOR-tier), so they self-gate role and take the project's
  // single-flight guard just like commit does. Discard reuses the SAME `gitChangeReconciler`
  // instance the PULL handler above already constructed, rather than building a second one; amend is
  // built from the same deps `CommitChangesUseCase` uses.
  const discardChangesUseCase = new DiscardChangesUseCase(
    projectMemberRepository,
    auditLogRepository,
    gitRepositoryRepository,
    gitOperationRepository,
    gitCommandRunner,
    gitChangeReconciler,
    useCaseLogger,
  );
  const amendCommitUseCase = new AmendCommitUseCase(
    projectMemberRepository,
    auditLogRepository,
    gitRepositoryRepository,
    gitOperationRepository,
    gitCommandRunner,
    fileNodeRepository,
    documentRepository,
    collaborativeContentReader,
    collaborationSessionRepository,
    userRepository,
    editorPreferencesRepository,
    useCaseLogger,
  );

  // Bound as the internal RPC server's op fns (`src/index.ts`): each converts the raw UUID
  // strings the transport validated into the domain's own `ProjectId`/`UserId` value objects at
  // this boundary, then hands the request straight to the use case's own `execute`.
  const getStatus = (input: { projectId: string; actorId: string }): Promise<Result<GetGitStatusResult, DomainError>> =>
    getGitStatusUseCase.execute({ projectId: ProjectId.create(input.projectId) });
  const getBehindAhead = (input: { projectId: string; actorId: string }): Promise<Result<GitBehindAhead, DomainError>> =>
    getBehindAheadUseCase.execute({ projectId: ProjectId.create(input.projectId) });
  const stage = (input: { projectId: string; actorId: string; paths: readonly string[] }): Promise<Result<StageChangesResult, DomainError>> =>
    stageChangesUseCase.execute({
      projectId: ProjectId.create(input.projectId),
      actorId: UserId.create(input.actorId),
      paths: input.paths,
      action: 'stage',
    });
  const unstage = (input: { projectId: string; actorId: string; paths: readonly string[] }): Promise<Result<StageChangesResult, DomainError>> =>
    stageChangesUseCase.execute({
      projectId: ProjectId.create(input.projectId),
      actorId: UserId.create(input.actorId),
      paths: input.paths,
      action: 'unstage',
    });
  const commit = (input: { projectId: string; actorId: string; message: string }): Promise<Result<CommitChangesResult, DomainError>> =>
    commitChangesUseCase.execute({
      projectId: ProjectId.create(input.projectId),
      actorId: UserId.create(input.actorId),
      message: input.message,
    });
  const getBranches = (input: { projectId: string; actorId: string }): Promise<Result<GetBranchesResult, DomainError>> =>
    getBranchesUseCase.execute({ projectId: ProjectId.create(input.projectId) });
  const createBranch = (input: { projectId: string; actorId: string; name: string }): Promise<Result<CreateBranchResult, DomainError>> =>
    createBranchUseCase.execute({
      projectId: ProjectId.create(input.projectId),
      actorId: UserId.create(input.actorId),
      name: input.name,
    });
  const completePull = async (
    input: { projectId: string; actorId: string },
  ): Promise<Result<CompleteMergeWireResult, DomainError>> => {
    const result = await completeMergeUseCase.execute({
      projectId: ProjectId.create(input.projectId),
      actorId: UserId.create(input.actorId),
    });
    return result.success ? { success: true, value: mapOperationId(result.value) } : result;
  };
  const undoPull = async (
    input: { projectId: string; actorId: string },
  ): Promise<Result<UndoPullWireResult, DomainError>> => {
    const result = await undoPullUseCase.execute({
      projectId: ProjectId.create(input.projectId),
      actorId: UserId.create(input.actorId),
    });
    return result.success ? { success: true, value: mapOperationId(result.value) } : result;
  };
  const listConflicts = async (
    input: { projectId: string; actorId: string },
  ): Promise<Result<ListConflictsWireResult, DomainError>> => {
    const result = await listConflictsUseCase.execute({ projectId: ProjectId.create(input.projectId) });
    return result.success ? { success: true, value: mapOperationId(result.value) } : result;
  };
  const getConflictStages = (
    input: { projectId: string; actorId: string; path: string },
  ): Promise<Result<GetConflictStagesResult, DomainError>> =>
    getConflictStagesUseCase.execute({ projectId: ProjectId.create(input.projectId), path: input.path });
  const resolveConflict = (
    input: {
      projectId: string;
      actorId: string;
      path: string;
      resolution: ConflictResolution;
      mergedContent?: string;
    },
  ): Promise<Result<ResolveConflictsResult, DomainError>> =>
    resolveConflictsUseCase.execute({
      projectId: ProjectId.create(input.projectId),
      actorId: UserId.create(input.actorId),
      path: input.path,
      resolution: input.resolution,
      ...(input.mergedContent === undefined ? {} : { mergedContent: input.mergedContent }),
    });
  const getHistory = async (
    input: { projectId: string; actorId: string; path?: string; limit?: number },
  ): Promise<Result<GetHistoryWireResult, DomainError>> => {
    const result = await getHistoryUseCase.execute({
      projectId: ProjectId.create(input.projectId),
      ...(input.path === undefined ? {} : { path: input.path }),
      ...(input.limit === undefined ? {} : { limit: input.limit }),
    });
    if (!result.success) return result;
    return {
      success: true,
      value: { commits: mapHistoryCommitsToWire(result.value.commits) },
    };
  };
  const getDiff = (
    input: { projectId: string; actorId: string; path?: string; from?: string; to?: string },
  ): Promise<Result<GitDiffResult, DomainError>> =>
    getDiffUseCase.execute({
      projectId: ProjectId.create(input.projectId),
      ...(input.path === undefined ? {} : { path: input.path }),
      ...(input.from === undefined ? {} : { from: input.from }),
      ...(input.to === undefined ? {} : { to: input.to }),
    });
  const getBlame = async (
    input: { projectId: string; actorId: string; path: string; ref?: string },
  ): Promise<Result<GetBlameWireResult, DomainError>> => {
    const result = await getBlameUseCase.execute({
      projectId: ProjectId.create(input.projectId),
      path: input.path,
      ...(input.ref === undefined ? {} : { ref: input.ref }),
    });
    if (!result.success) return result;
    return {
      success: true,
      value: {
        lines: result.value.lines.map((line) => ({
          lineNumber: line.lineNumber,
          hash: line.hash,
          message: line.message,
          ...(line.authorUserId === undefined ? {} : { authorUserId: line.authorUserId.value }),
          authoredAt: line.authoredAt.toISOString(),
          content: line.content,
        })),
      },
    };
  };
  const discard = (
    input: { projectId: string; actorId: string; paths: readonly string[]; fromCommit?: string },
  ): Promise<Result<DiscardChangesResult, DomainError>> =>
    discardChangesUseCase.execute({
      projectId: ProjectId.create(input.projectId),
      actorId: UserId.create(input.actorId),
      paths: input.paths,
      ...(input.fromCommit === undefined ? {} : { fromCommit: input.fromCommit }),
    });
  const amend = (
    input: { projectId: string; actorId: string; message?: string },
  ): Promise<Result<AmendCommitResult, DomainError>> =>
    amendCommitUseCase.execute({
      projectId: ProjectId.create(input.projectId),
      actorId: UserId.create(input.actorId),
      ...(input.message === undefined ? {} : { message: input.message }),
    });

  const loop: GitWorkerLoop = createGitWorkerLoop({
    gitOperationRepository,
    auditLogRepository,
    handlers,
    ensureCleanWorkingTree: (operation) =>
      ensureCleanWorkingTree(resolveWorkingTreePath(storageRoot, operation.projectId)),
    logger,
    pollIntervalMs: config.get('pollIntervalMs'),
    heartbeatIntervalMs: config.get('heartbeatIntervalMs'),
    staleHeartbeatAfterMs: config.get('staleHeartbeatAfterMs'),
  });

  // Periodically enqueues a FETCH GitOperation for every connected repository so a "behind by N —
  // pull available" prompt surfaces on its own. The scheduler only enqueues; the FETCH dispatch
  // handler above runs the actual refs-only refresh when the run loop claims the operation, which is
  // what serializes the background fetch against user pull/push/switch through the same single-flight
  // queue (no separate lock). Egress stays enforced by the use case's own fetch path.
  // Belt-and-braces backstop to the inline prune each content op runs: sweeps any orphaned
  // `refs/adc/undo/*` a crash left behind, keeping exactly one retained undo point per project. Runs
  // per connected repo alongside the FETCH enqueue below (skipping any repo with an active op).
  const undoReferenceSweeper = createUndoReferenceSweeper({
    storageRoot,
    gitOperationRepository,
    conflictStageStore,
    logger,
  });

  const remoteRefreshScheduler: RemoteRefreshScheduler = createRemoteRefreshScheduler({
    gitRepositoryRepository,
    gitOperationRepository,
    logger,
    intervalMs: config.get('backgroundRefreshIntervalMs'),
    enabled: config.get('backgroundRefreshEnabled'),
    maxConcurrency: config.get('backgroundRefreshMaxConcurrency'),
    undoRefSweeper: undoReferenceSweeper,
  });

  let running = false;

  return {
    async start() {
      logger.info('git-worker starting');
      loop.start();
      remoteRefreshScheduler.start();
      running = true;
    },
    async shutdown() {
      logger.info('git-worker shutting down');
      await loop.stop();
      await remoteRefreshScheduler.stop();
      await prisma.$disconnect();
      running = false;
    },
    isRunning() {
      return running;
    },
    // Exposed beyond the GitWorkerApp contract so tests and a future story task's wiring can
    // reach the constructed adapters without re-deriving them.
    gitOperationRepository,
    gitCredentialStore,
    gitCommandRunner,
    conflictStageStore,
    auditLogRepository,
    config,
    // The internal RPC server's op fns — `src/index.ts` passes these straight to
    // `startInternalGitServer` once this composition root resolves.
    getStatus,
    getBehindAhead,
    stage,
    unstage,
    commit,
    connect,
    getBranches,
    createBranch,
    completePull,
    undoPull,
    listConflicts,
    getConflictStages,
    resolveConflict,
    getHistory,
    getDiff,
    getBlame,
    discard,
    amend,
    previewPull,
    previewPush,
  };
}
