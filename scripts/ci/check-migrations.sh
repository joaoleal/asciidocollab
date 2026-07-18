#!/usr/bin/env bash
#
# Fails if prisma/schema.prisma has drifted from prisma/migrations/.
#
# Why this exists: development and e2e apply the schema with `prisma db push`,
# which writes changes straight into the database without producing a migration.
# Production applies `prisma migrate deploy`, which only ever runs the committed
# migrations. Without this check, a schema change could work perfectly all the
# way through CI and then simply never reach production.
#
# The check replays the migration history into a throwaway shadow database and
# compares the result against schema.prisma.
#
#   Drift found  -> exit 1, with the SQL needed to fix it
#   In sync      -> exit 0
#
# Requires a reachable PostgreSQL. Set ASCIIDOCOLLAB_SHADOW_DATABASE_URL to
# override the default, which targets the local dev stack.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DB_DIR="$ROOT/packages/db"

SHADOW_URL="${ASCIIDOCOLLAB_SHADOW_DATABASE_URL:-postgresql://asciidocollab:asciidocollab@localhost:5432/asciidocollab_shadow}"
export ASCIIDOCOLLAB_SHADOW_DATABASE_URL="$SHADOW_URL"

echo "==> checking prisma/migrations is in sync with schema.prisma"

cd "$DB_DIR"

# Prisma will not create the shadow database for `migrate diff`, so make sure it
# exists. Uses the pg driver already in the workspace rather than requiring a
# psql client on the host. Safe to re-run: "already exists" is not an error.
node -e '
const { Client } = require("pg");
const url = new URL(process.env.ASCIIDOCOLLAB_SHADOW_DATABASE_URL);
const dbName = url.pathname.slice(1);
const admin = new URL(url.toString());
admin.pathname = "/postgres";
(async () => {
  const c = new Client({ connectionString: admin.toString() });
  await c.connect();
  try {
    await c.query(`CREATE DATABASE "${dbName}"`);
  } catch (e) {
    if (e.code !== "42P04") throw e;   // 42P04 = duplicate_database
  } finally {
    await c.end();
  }
})().catch((e) => { console.error(e.message); process.exit(1); });
' || {
  # Lenient locally, strict in CI — the same contract scripts/ci/security.sh uses.
  # A developer without the dev stack up should not be blocked; CI must never
  # silently skip the check.
  if [ -n "${CI:-}" ] || [ -n "${MIGRATION_CHECK_STRICT:-}" ]; then
    echo "!!! could not reach PostgreSQL to create the shadow database" >&2
    echo "    $SHADOW_URL" >&2
    exit 1
  fi
  echo "==> SKIPPED — no PostgreSQL reachable at $SHADOW_URL"
  echo "    Start the dev stack (scripts/dev.sh) to run it, or set MIGRATION_CHECK_STRICT=1 to require it."
  exit 0
}
set +e
pnpm exec prisma migrate diff \
  --from-migrations prisma/migrations \
  --to-schema prisma/schema.prisma \
  --script --exit-code > /tmp/adc-migration-drift.sql 2>/tmp/adc-migration-drift.err
STATUS=$?
set -e

case "$STATUS" in
  0)
    echo "==> in sync — migrations reproduce schema.prisma exactly"
    ;;
  2)
    echo "!!! schema.prisma has drifted from prisma/migrations/" >&2
    echo >&2
    echo "The schema was changed without adding a migration. Development uses" >&2
    echo "\`db push\` so this works locally, but production runs \`migrate deploy\`" >&2
    echo "and would NOT apply the change." >&2
    echo >&2
    echo "Missing SQL:" >&2
    sed 's/^/  /' /tmp/adc-migration-drift.sql >&2
    echo >&2
    echo "Fix it by generating a migration:" >&2
    echo "  cd packages/db && pnpm exec prisma migrate dev --name <describe-the-change>" >&2
    exit 1
    ;;
  *)
    echo "!!! could not run the drift check" >&2
    cat /tmp/adc-migration-drift.err >&2
    echo >&2
    echo "It needs a reachable PostgreSQL for the shadow database:" >&2
    echo "  $SHADOW_URL" >&2
    echo "Start the dev stack (scripts/dev.sh) or set ASCIIDOCOLLAB_SHADOW_DATABASE_URL." >&2
    exit 1
    ;;
esac
