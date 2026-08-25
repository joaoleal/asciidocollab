import { readFileSync } from 'node:fs';
import pino from 'pino';
import { compositionRoot } from './composition-root.js';
import { startInternalGitServer } from './internal-git-server.js';

const logger = pino();

async function main() {
  const app = await compositionRoot();
  await app.start();
  logger.info('git-worker started');

  // Internal endpoint that lets the API run the git short ops (status, behind-ahead, stage,
  // unstage, commit) worker-side, against the real git adapter — the synchronous RPC counterpart
  // to the queue this worker otherwise polls. Bound to loopback; secret-gated when configured.
  const gitSecret = app.config.get('internalGitSecret');
  const gitTlsCert = app.config.get('internalGitTls.cert');
  const gitTlsKey = app.config.get('internalGitTls.key');
  const gitTlsClientCa = app.config.get('internalGitTls.clientCa');
  const gitTls = gitTlsCert && gitTlsKey && gitTlsClientCa
    ? { cert: readFileSync(gitTlsCert), key: readFileSync(gitTlsKey), clientCa: readFileSync(gitTlsClientCa) }
    : undefined;
  const internalGitServer = await startInternalGitServer({
    host: app.config.get('internalGitHost'),
    port: app.config.get('internalGitPort'),
    ...(gitSecret ? { secret: gitSecret } : {}),
    ...(gitTls ? { tls: gitTls } : {}),
    logger,
    getStatus: app.getStatus,
    getBehindAhead: app.getBehindAhead,
    stage: app.stage,
    unstage: app.unstage,
    commit: app.commit,
  });

  async function shutdown() {
    logger.info('Shutting down git-worker…');
    try {
      // close() only fires its callback once all sockets end; the API client keeps idle keep-alive
      // sockets pooled, so without closeAllConnections() the await would hang and skip the teardown
      // below. Forcibly terminate live connections so shutdown always proceeds.
      await new Promise<void>((resolve) => {
        internalGitServer.close(() => resolve());
        internalGitServer.closeAllConnections?.();
      });
      await app.shutdown();
      logger.info('Shutdown complete');
    } catch (error) {
      logger.error({ err: error }, 'Error during shutdown');
      process.exit(1);
    }
  }

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((error) => {
  logger.error({ err: error }, 'Fatal error during startup');
  process.exit(1);
});
