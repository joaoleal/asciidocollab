-- Enforces "at most one active GitOperation per project" (single-flight guard + write-lock) at the
-- database level: a partial UNIQUE index on projectId, scoped to the non-terminal states. Prisma
-- 7.9's schema DSL cannot express a partial UNIQUE index (`@@index(..., where: ...)` needs the
-- unreleased "partialIndexes" preview feature and only produces a non-unique filtered index; adding
-- `unique: true` alongside `where` is rejected by the CLI), so this is hand-authored raw SQL rather
-- than something `prisma migrate dev` could have generated from the schema.
--
-- The identical statement was previously captured (unapplied) at
-- packages/infrastructure/src/persistence/git/git-operation-active-op-unique-index.sql pending
-- authorization to add a migration for this feature; see the comment on the `GitOperation` model in
-- packages/db/prisma/schema.prisma.
CREATE UNIQUE INDEX IF NOT EXISTS "GitOperation_one_active_per_project"
  ON "GitOperation" ("projectId")
  WHERE "state" IN ('QUEUED', 'RUNNING', 'AWAITING_CONFLICT');
