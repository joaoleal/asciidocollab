import { GenericContainer, StartedTestContainer } from 'testcontainers';
import { PrismaClient } from '@asciidocollab/db';
import { PrismaPg } from '@prisma/adapter-pg';
import { execSync } from 'child_process';
import path from 'path';
import fs from 'fs';

/**
 * Test container context for database-backed tests.
 */
export interface TestContainer {
  /** The running PostgreSQL container. */
  container: StartedTestContainer;
  /** Prisma client connected to the test database. */
  client: PrismaClient;
}

function findRootDirectory(directory: string): string {
  const marker = path.join(directory, 'pnpm-workspace.yaml');
  if (fs.existsSync(marker)) return directory;
  const parent = path.dirname(directory);
  if (parent === directory) return directory;
  return findRootDirectory(parent);
}

/**
 * Backoff before each retry of the container start, in milliseconds.
 *
 * Four attempts in total. Sized for a registry hiccup measured in seconds — the failure this exists
 * for reset the connection immediately rather than hanging — and deliberately not longer: a registry
 * that is still refusing after ~17s is an outage, and a suite that waits minutes to say so is worse
 * than one that fails while the reason is still on screen.
 */
const CONTAINER_START_BACKOFF_MS = [2000, 5000, 10_000];

/**
 * Whether a failed container start is worth another attempt.
 *
 * Pulling the image is a network call to a third party, and it fails in ways that have nothing to do
 * with the code under test: a 500 from the registry, a reset connection, a DNS blip, an anonymous
 * pull-rate limit. Those are transient by nature and retrying is the correct response. A missing
 * image or a malformed configuration is not, and retrying it just delays a failure that was never
 * going to resolve itself — so the match is on the transport, not on "anything that threw".
 *
 * @param error - The rejection from `.start()`.
 * @returns True when the failure looks like the registry or the network rather than the container.
 */
function isTransientStartFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return [
    'registry-1.docker.io',
    'auth.docker.io',
    'connection reset',
    'ECONNRESET',
    'ETIMEDOUT',
    'EAI_AGAIN',
    'ENOTFOUND',
    'TLS handshake',
    'toomanyrequests',
    'i/o timeout',
    'server error',
  ].some((marker) => message.toLowerCase().includes(marker.toLowerCase()));
}

/**
 * Starts a PostgreSQL test container and pushes the Prisma schema.
 *
 * The start is retried on transient registry failures. Every one of these suites pulls its image
 * from Docker Hub at test time, so a few seconds of trouble there failed the whole integration job
 * with nothing wrong in the repository — and no amount of test-level retry helps, because the
 * container never came up for the tests to run in. Retrying here covers all of them at once, and
 * covers a local run as well as CI.
 *
 * @returns A TestContainer with the running container and connected Prisma client.
 * @throws {Error} The last error from `.start()` if every attempt failed, or immediately for a
 *   failure that retrying cannot fix.
 */
export async function startTestContainer(): Promise<TestContainer> {
  const image = new GenericContainer('postgres:16-alpine')
    .withEnvironment({ POSTGRES_USER: 'test', POSTGRES_PASSWORD: 'test', POSTGRES_DB: 'test' })
    .withExposedPorts(5432);

  let container: StartedTestContainer | undefined;
  for (let attempt = 0; container === undefined; attempt += 1) {
    try {
      container = await image.start();
    } catch (error) {
      const backoffMs = CONTAINER_START_BACKOFF_MS[attempt];
      if (backoffMs === undefined || !isTransientStartFailure(error)) throw error;
      // Reported rather than swallowed: a suite that took 17s longer than usual should say why, and
      // a retry that becomes routine is a signal about the registry worth seeing in the log.
      console.warn(
        `[test-container] start failed (${error instanceof Error ? error.message : String(error)}); ` +
          `retrying in ${backoffMs}ms — attempt ${attempt + 2} of ${CONTAINER_START_BACKOFF_MS.length + 1}`,
      );
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
    }
  }

  const port = container.getMappedPort(5432);
  const host = container.getHost();
  const databaseUrl = `postgresql://test:test@${host}:${port}/test`;

  const rootDirectory = findRootDirectory(__dirname);
  const schemaPath = path.join(rootDirectory, 'packages', 'db', 'prisma', 'schema.prisma');

  execSync(`npx prisma db push --schema="${schemaPath}" --accept-data-loss`, {
    env: { ...process.env, ASCIIDOCOLLAB_DATABASE_URL: databaseUrl },
    cwd: path.join(rootDirectory, 'packages', 'db'),
    stdio: 'pipe',
  });

  const adapter = new PrismaPg(databaseUrl);
  const client = new PrismaClient({ adapter });

  return { container, client };
}

/**
 * Stops the test container and disconnects the Prisma client.
 *
 * Tolerates being handed nothing, because that is exactly what happens when the suite failed to get
 * a container in the first place. Every caller follows the same shape — a `let` assigned in
 * `beforeAll`, torn down in `afterAll` — so a `startTestContainer` that throws leaves the variable
 * undefined and `afterAll` still runs. Dereferencing it raised a TypeError that jest reports as
 * "Test suite failed to run", REPLACING the message that explains the failure (most often a registry
 * refusing to serve the postgres image) with one that says nothing about the cause. Returning early
 * lets the real error be the one that is read.
 *
 * @param testContext - The test container context to stop, or undefined if it was never obtained.
 */
export async function stopTestContainer(testContext: TestContainer | undefined): Promise<void> {
  if (testContext === undefined) return;
  try {
    await testContext.client.$disconnect();
  } finally {
    // Stopped even when disconnecting threw. Skipping it would leak a running container for the rest
    // of the run, and a failed disconnect is much the less consequential of the two.
    await testContext.container.stop();
  }
}
