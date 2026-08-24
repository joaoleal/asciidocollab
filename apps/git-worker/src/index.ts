import pino from 'pino';
import { compositionRoot } from './composition-root.js';

const logger = pino();

async function main() {
  const app = await compositionRoot();
  await app.start();
  logger.info('git-worker started');

  async function shutdown() {
    logger.info('Shutting down git-worker…');
    try {
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
