-- This statement is now applied via the
-- packages/db/prisma/migrations/20260828120000_git_operation_active_op_unique_index/migration.sql
-- migration (kept here, verbatim, as the historical capture that migration was authored from — see
-- that migration's header for why this is hand-authored raw SQL rather than schema DSL).
--
-- Enforces "at most one active GitOperation per project" (single-flight guard + write-lock):
-- a partial UNIQUE index on projectId, scoped to the non-terminal states. Prisma 7.9's
-- schema DSL cannot express a partial UNIQUE index (`@@index(..., where: ...)` needs the
-- unreleased "partialIndexes" preview feature and only produces a non-unique filtered index;
-- adding `unique: true` alongside `where` is rejected by the CLI).
--
-- MIGRATION-DRIFT GATE (scripts/ci/check-migrations.sh): this divergence is INVISIBLE to the gate —
-- it passes ("in sync"), verified 2026-08 against a real Postgres. `prisma migrate diff
-- --from-migrations --to-schema` builds an abstract datamodel from each side, and a partial (filtered)
-- UNIQUE index is not representable in that model, so it is dropped from the migrations side and was
-- never in the schema.prisma side — both sides lack it, so no drift is reported. This is expected, not
-- a bug to "fix": do NOT try to add this index to schema.prisma's DSL to silence a phantom (it cannot
-- express it — see below), and do NOT delete this raw SQL believing the gate proved it redundant.
--
-- PrismaGitOperationRepository#withGuard (prisma-git-operation.repository.ts, same directory) still
-- enforces single-flight defensively for synchronous callers via a SERIALIZABLE transaction — see
-- that file's class docs for the full mechanism. For the async queued path, this index (plus the
-- queued operation's own active row) IS the single-flight guarantee; it also backstops a stray
-- INSERT that bypasses `withGuard` entirely.
CREATE UNIQUE INDEX IF NOT EXISTS "GitOperation_one_active_per_project"
  ON "GitOperation" ("projectId")
  WHERE "state" IN ('QUEUED', 'RUNNING', 'AWAITING_CONFLICT');
