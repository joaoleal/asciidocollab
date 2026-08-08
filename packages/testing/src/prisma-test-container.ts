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
 * Starts a PostgreSQL test container and pushes the Prisma schema.
 *
 * @returns A TestContainer with the running container and connected Prisma client.
 */
export async function startTestContainer(): Promise<TestContainer> {
  const container = await new GenericContainer('postgres:16-alpine')
    .withEnvironment({ POSTGRES_USER: 'test', POSTGRES_PASSWORD: 'test', POSTGRES_DB: 'test' })
    .withExposedPorts(5432)
    .start();

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
