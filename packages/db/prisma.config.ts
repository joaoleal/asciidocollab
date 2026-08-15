import { defineConfig } from 'prisma/config';

// Optional shadow database, used only by tooling that must replay the migration
// history to compare it against schema.prisma (see scripts/ci/check-migrations.sh).
// It is never used at runtime, and is left unset in normal development.
const shadowDatabaseUrl = process.env.ASCIIDOCOLLAB_SHADOW_DATABASE_URL;

/**
 * Thrown when a Prisma command that needs a database is run without one.
 *
 * There is deliberately NO default connection string here. The previous default
 * (`postgresql://localhost:5432/dev`) named a real host and port — the developer
 * PostgreSQL container this project runs on 5432 — so an unset variable turned
 * `prisma db push --accept-data-loss` into a command aimed at whatever it could
 * reach there rather than at the throwaway database the caller meant. Failing is
 * the only safe answer: a schema command must be told which database to change.
 */
class MissingDatabaseUrlError extends Error {
  constructor() {
    super(
      'MissingDatabaseUrlError: ASCIIDOCOLLAB_DATABASE_URL is not set, and this ' +
        'Prisma command needs a database (db push / migrate / diff all read the ' +
        'datasource URL). There is no default on purpose — guessing a connection ' +
        'string once meant pointing a destructive schema command at a real local ' +
        'database. Export ASCIIDOCOLLAB_DATABASE_URL with the database you intend ' +
        'to change (see .env.example), or run the command through the script that ' +
        'owns its stack: scripts/dev.sh, scripts/ci/e2e-local.sh, scripts/ci/e2e.sh.',
    );
    this.name = 'MissingDatabaseUrlError';
  }
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  datasource: {
    // A getter, not a plain value, so the check runs when a command actually asks
    // for the datasource. `prisma generate` never does — and it is part of this
    // package's `build`, which runs in the Docker image build and in CI where no
    // database exists — so an eager throw here would break those builds.
    get url(): string {
      const url = process.env.ASCIIDOCOLLAB_DATABASE_URL;
      if (!url) throw new MissingDatabaseUrlError();
      return url;
    },
    ...(shadowDatabaseUrl ? { shadowDatabaseUrl } : {}),
  },
});
