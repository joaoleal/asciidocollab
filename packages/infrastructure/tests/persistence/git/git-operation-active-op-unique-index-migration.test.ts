import { readFileSync } from 'fs';
import path from 'path';

/**
 * Regression coverage for the `GitOperation_one_active_per_project` partial-unique index migration
 * (see the async-INITIALIZE self-deadlock fix in `prisma-git-operation.repository.ts`'s `withGuard`).
 * The index cannot be expressed in Prisma's schema DSL, so it lives as hand-authored raw SQL in a
 * migration file rather than something a schema diff could regenerate — this guards against that
 * file drifting from the statement `withGuard`'s async path relies on, or being accidentally
 * emptied/reworded during a future edit.
 */
const migrationFilePath = path.join(
  __dirname,
  '../../../../db/prisma/migrations/20260828120000_git_operation_active_op_unique_index/migration.sql',
);

const capturedFilePath = path.join(
  __dirname,
  '../../../src/persistence/git/git-operation-active-op-unique-index.sql',
);

/** Extracts the `CREATE UNIQUE INDEX …;` statement (and nothing before it) from a `.sql` file's contents. */
function extractCreateIndexStatement(sql: string): string {
  const startIndex = sql.indexOf('CREATE UNIQUE INDEX');
  if (startIndex === -1) throw new Error('CREATE UNIQUE INDEX statement not found');
  return sql.slice(startIndex).trim();
}

describe('GitOperation_one_active_per_project migration', () => {
  it('contains the exact partial-unique index statement the async withGuard path relies on', () => {
    const migrationSql = readFileSync(migrationFilePath, 'utf8');

    expect(migrationSql).toContain(
      'CREATE UNIQUE INDEX IF NOT EXISTS "GitOperation_one_active_per_project"',
    );
    expect(migrationSql).toContain('ON "GitOperation" ("projectId")');
    expect(migrationSql).toContain(`WHERE "state" IN ('QUEUED', 'RUNNING', 'AWAITING_CONFLICT')`);
  });

  it('matches the statement captured alongside the Prisma adapter', () => {
    const migrationSql = readFileSync(migrationFilePath, 'utf8');
    const capturedSql = readFileSync(capturedFilePath, 'utf8');

    expect(extractCreateIndexStatement(migrationSql)).toBe(extractCreateIndexStatement(capturedSql));
  });
});
