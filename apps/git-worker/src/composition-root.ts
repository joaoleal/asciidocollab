import pino from 'pino';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import type { Logger } from '@asciidocollab/domain';
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
  FilesystemProjectFileStore,
  SessionEncryption,
} from '@asciidocollab/infrastructure';
import { createGitWorkerConfig } from './config/git-worker-config.js';
import { RealGitCommandRunner } from './git/git-command-runner.js';
import { ensureCleanWorkingTree, resolveWorkingTreePath } from './git/working-tree.js';
import { createGitWorkerLoop, type GitWorkerLoop } from './worker-loop.js';
import { createImportHandler } from './dispatch/import-handler.js';
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
 * `IMPORT` is the only `GitOperationKind` with a registered handler so far — every other kind is
 * still a future story task's job (YAGNI). Until a story task registers one, a claimed operation
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
  const importUseCaseLogger: Logger = {
    warn: (message, meta) => logger.warn(meta ?? {}, message),
  };

  const handlers: GitOperationHandlerRegistry = {
    IMPORT: createImportHandler({
      projectRepository: new PrismaProjectRepository(prisma),
      fileNodeRepository: new PrismaFileNodeRepository(prisma),
      documentRepository: new PrismaDocumentRepository(prisma),
      assetRepository: new PrismaAssetRepository(prisma),
      // The CONTENT-BYTES projection path — deliberately `contentStorageRoot`, NOT `storageRoot`
      // (that root is this worker's own git working-tree directory). See
      // `config/git-worker-config.ts`'s docs on why the two must never be conflated.
      fileStore: new FilesystemProjectFileStore(config.get('contentStorageRoot')),
      gitRepositoryRepository: new PrismaGitRepositoryRepository(prisma),
      commandRunner: gitCommandRunner,
      projectMemberRepository: new PrismaProjectMemberRepository(prisma),
      auditLogRepository,
      credentialSource: gitCredentialStore,
      logger: importUseCaseLogger,
    }),
  };

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
  };
}
