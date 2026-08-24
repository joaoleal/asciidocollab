import pino from 'pino';

/**
 * The wired git-worker application. `src/index.ts` drives its lifecycle: construct via
 * {@link compositionRoot}, `start()` it, then `shutdown()` it on SIGTERM/SIGINT.
 */
export interface GitWorkerApp {
  /**
   * Starts the git-worker application.
   *
   * @returns Resolves once startup completes.
   */
  start(): Promise<void>;
  /**
   * Shuts down the git-worker application, releasing any resources acquired by `start()`.
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
 * Wires up the git-worker application.
 *
 * This is a skeleton composition root: it does not yet construct the `GitOperation` work-list poll
 * loop, the `GitCommandRunner` adapter, or the internal sync RPC server — those land once the
 * corresponding domain ports and infrastructure adapters are built. For now it only establishes the
 * start/shutdown lifecycle that `src/index.ts` drives, so later work has a stable seam to wire into.
 *
 * @returns The composed application, ready to start.
 */
export async function compositionRoot(): Promise<GitWorkerApp> {
  const logger = pino();
  let running = false;

  return {
    async start() {
      logger.info('git-worker starting (skeleton: run loop and adapters not wired yet)');
      running = true;
    },
    async shutdown() {
      logger.info('git-worker shutting down');
      running = false;
    },
    isRunning() {
      return running;
    },
  };
}
