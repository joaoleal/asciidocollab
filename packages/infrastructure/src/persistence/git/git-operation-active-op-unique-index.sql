-- Captured artifact — NOT run by anything yet. Prisma migrations are deferred for this feature
-- until explicitly authorized (Database Migration Policy); this file exists so the constraint is
-- not lost before that authorization happens.
--
-- Enforces "at most one active GitOperation per project" (single-flight guard + write-lock,
-- FR-009): a partial UNIQUE index on projectId, scoped to the non-terminal states. Prisma 7.9's
-- schema DSL cannot express a partial UNIQUE index (`@@index(..., where: ...)` needs the
-- unreleased "partialIndexes" preview feature and only produces a non-unique filtered index;
-- adding `unique: true` alongside `where` is rejected by the CLI), so this constraint currently
-- exists ONLY as the comment on the `GitOperation` model in packages/db/prisma/schema.prisma —
-- there is no DB-level enforcement of it today. When a migration is authorized for this feature,
-- this statement (or the equivalent `migration.sql` entry) MUST be included.
--
-- Until then, PrismaGitOperationRepository#withGuard (prisma-git-operation.repository.ts, same
-- directory) enforces single-flight defensively without this index, via a SERIALIZABLE
-- transaction — see that file's class docs for the full mechanism. Once this index exists, it can
-- additionally serve as a backstop (a stray INSERT bypassing withGuard would still fail).
CREATE UNIQUE INDEX IF NOT EXISTS "GitOperation_one_active_per_project"
  ON "GitOperation" ("projectId")
  WHERE "state" IN ('QUEUED', 'RUNNING', 'AWAITING_CONFLICT');
