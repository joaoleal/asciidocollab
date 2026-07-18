import { defineConfig } from 'prisma/config';

// Optional shadow database, used only by tooling that must replay the migration
// history to compare it against schema.prisma (see scripts/ci/check-migrations.sh).
// It is never used at runtime, and is left unset in normal development.
const shadowDatabaseUrl = process.env.ASCIIDOCOLLAB_SHADOW_DATABASE_URL;

export default defineConfig({
  schema: 'prisma/schema.prisma',
  datasource: {
    url: process.env.ASCIIDOCOLLAB_DATABASE_URL ?? 'postgresql://localhost:5432/dev',
    ...(shadowDatabaseUrl ? { shadowDatabaseUrl } : {}),
  },
});
