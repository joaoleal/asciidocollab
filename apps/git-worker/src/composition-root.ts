import pino from 'pino';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import {
  PrismaGitOperationRepository,
  PrismaGitCredentialStore,
  PrismaAuditLogRepository,
  SessionEncryption,
} from '@asciidocollab/infrastructure';
import { createGitWorkerConfig } from './config/git-worker-config.js';
import { RealGitCommandRunner } from './git/git-command-runner.js';
import { ensureCleanWorkingTree, resolveWorkingTreePath } from './git/working-tree.js';
import { createGitWorkerLoop, type GitWorkerLoop } from './worker-loop.js';
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
 * `GitCredentialStore`, `GitCommandRunner`, `AuditLogRepository`) from config, and the run loop
 * that polls/claims `GitOperation` work, dispatches it, and records its outcome.
 *
 * No `GitOperationKind` has a registered handler yet — each git use case is a story task's job,
 * not this one's (YAGNI). Until a story task registers one, every claimed operation dispatches
 * to the `UNHANDLED_GIT_OPERATION_KIND` failure path (see `dispatch/git-operation-dispatcher.ts`),
 * so a claimed op always reaches a terminal state — and releases the single-flight lock it
 * holds — rather than hanging forever. `gitCredentialStore` and `gitCommandRunner` are already
 * constructed here, ready for those handlers to close over once they exist.
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
  // Constructed for future use-case handlers to close over; the empty registry below doesn't
  // call either yet (see this function's docs).
  const gitCredentialStore = new PrismaGitCredentialStore(prisma, credentialEncryption);
  const storageRoot = config.get('storageRoot');
  const gitCommandRunner = new RealGitCommandRunner(storageRoot);

  const handlers: GitOperationHandlerRegistry = {};

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
