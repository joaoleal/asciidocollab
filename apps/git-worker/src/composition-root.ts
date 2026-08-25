import { readFileSync } from 'node:fs';
import pino from 'pino';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import {
  GetGitStatusUseCase,
  StageChangesUseCase,
  CommitChangesUseCase,
  GitChangeReconciler,
  ProjectId,
  UserId,
  type Logger,
  type GetGitStatusResult,
  type StageChangesResult,
  type CommitChangesResult,
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
  FilesystemProjectFileStore,
  HttpCollaborativeContentEditor,
  SessionEncryption,
} from '@asciidocollab/infrastructure';
import { createGitWorkerConfig } from './config/git-worker-config.js';
import { RealGitCommandRunner } from './git/git-command-runner.js';
import { ensureCleanWorkingTree, resolveWorkingTreePath } from './git/working-tree.js';
import { createGitWorkerLoop, type GitWorkerLoop } from './worker-loop.js';
import { createImportHandler } from './dispatch/import-handler.js';
import { createPushHandler } from './dispatch/push-handler.js';
import { createPullHandler } from './dispatch/pull-handler.js';
import type { GitOperationHandlerRegistry } from './dispatch/git-operation-dispatcher.js';

/**
 * The wired git-worker application. `src/index.ts` drives its lifecycle: construct via
 * {@link compositionRoot}, `start()` it, then `shutdown()` it on SIGTERM/SIGINT.
 */
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
 * `IMPORT`, `PUSH`, and `PULL` are the `GitOperationKind`s with a registered handler so far — every
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
  const gitCommandRunner = new RealGitCommandRunner(storageRoot, config.get('egressAllowedHosts'));

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
  };

  // The short git ops (status/stage/unstage/commit) run synchronously, worker-side, through the
  // internal RPC server `src/index.ts` starts once this composition root resolves — see that
  // file for the `startInternalGitServer` call.
  const userRepository = new PrismaUserRepository(prisma);

  const getGitStatusUseCase = new GetGitStatusUseCase(gitRepositoryRepository, gitCommandRunner, useCaseLogger);
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
    useCaseLogger,
  );

  // Bound as the internal RPC server's op fns (`src/index.ts`): each converts the raw UUID
  // strings the transport validated into the domain's own `ProjectId`/`UserId` value objects at
  // this boundary, then hands the request straight to the use case's own `execute`.
  const getStatus = (input: { projectId: string; actorId: string }): Promise<Result<GetGitStatusResult, DomainError>> =>
    getGitStatusUseCase.execute({ projectId: ProjectId.create(input.projectId) });
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

  let running = false;

  return {
    async start() {
      logger.info('git-worker starting');
      loop.start();
      running = true;
    },
    async shutdown() {
      logger.info('git-worker shutting down');
      await loop.stop();
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
    auditLogRepository,
    config,
    // The internal RPC server's op fns — `src/index.ts` passes these straight to
    // `startInternalGitServer` once this composition root resolves.
    getStatus,
    stage,
    unstage,
    commit,
  };
}
