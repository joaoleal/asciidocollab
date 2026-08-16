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

# `migrate diff` reads the primary datasource URL out of prisma.config.ts even
# though this check only ever touches the shadow database, and that config no
# longer invents a default (it throws instead — see MissingDatabaseUrlError).
# Point it at the shadow database, UNCONDITIONALLY: the shadow database is the
# only database this script may legitimately write to, and overwriting whatever
# the caller exported is the point. A `:-` fallback here would mean any shell
# that had sourced the dev environment (scripts/dev.sh) silently resolved the
# primary datasource to the real dev database — the exact "ambient env selects
# the target" shape that removing the localhost:5432/dev default from
# prisma.config.ts was meant to eliminate. `migrate diff --from-migrations
# --to-schema` happens not to connect to it today, so there is no exploit; that
# is a property of one Prisma command, not a guarantee worth depending on.
# No caller needs to override it: a drift check against a database other than
# the shadow one is not a thing this script offers. Aim the shadow database
# itself with ASCIIDOCOLLAB_SHADOW_DATABASE_URL.
export ASCIIDOCOLLAB_DATABASE_URL="$SHADOW_URL"

echo "==> checking prisma/migrations is in sync with schema.prisma"

cd "$DB_DIR"

# Prisma will not create the shadow database for `migrate diff`, so make sure it
# exists. Uses the pg driver declared by packages/db rather than requiring a psql
# client on the host. Safe to re-run: "already exists" is not an error.
#
# TWO failure classes, reported separately, because they mean opposite things and
# this block used to collapse them. A bare `|| { … SKIPPED … exit 0 }` catches
# ANY non-zero exit — a missing module, a malformed URL, a rejected password —
# and prints "no PostgreSQL reachable", green. `pg` was a PHANTOM dependency at
# the time: packages/db declared only @prisma/client, and `require("pg")`
# resolved to the copy the ROOT package.json happens to pull in. Dropping it from
# the root manifest would have left every gate printing SKIPPED and exiting 0
# forever, with a healthy database running the whole time and the migration-drift
# check never once executing. It is declared in packages/db now, and the exit
# codes below make the difference legible even if it goes missing again:
#
#   exit 3  the driver cannot be loaded — the check CANNOT RUN. Always fatal:
#           there is nothing to be lenient about, and no database was consulted.
#   exit 1  the driver loaded and the database refused or did not answer — the
#           documented local skip, still strict under CI.
# `|| PROBE=$?` rather than a bare call: `set -e` at the top of this script would abort on the
# non-zero exit before the code could be read, and the two classes below would never be told apart.
PROBE=0
node -e '
let Client;
try {
  ({ Client } = require("pg"));
} catch (e) {
  console.error("cannot load the `pg` driver: " + e.message);
  process.exit(3);
}
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
' || PROBE=$?

if [ "$PROBE" = "3" ]; then
  echo "!!! the \`pg\` driver is not installed where this script runs" >&2
  echo "    It is declared by packages/db; run \`pnpm install\` from the repository root." >&2
  echo "    This is NOT the 'no database' skip: nothing was asked of PostgreSQL, so the" >&2
  echo "    migration-drift check did not run and its result is unknown." >&2
  exit 1
fi

if [ "$PROBE" != "0" ]; then
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
fi
# Private, unpredictable paths — not fixed /tmp names. A fixed name on a shared
# host is written through a symlink an attacker pre-created, and two concurrent
# gate runs clobber each other, so the "Missing SQL" below could print the other
# run's diff.
DRIFT_SQL="$(mktemp -t adc-migration-drift.XXXXXX.sql)"
DRIFT_ERR="$(mktemp -t adc-migration-drift.XXXXXX.err)"
trap 'rm -f "$DRIFT_SQL" "$DRIFT_ERR"' EXIT

set +e
pnpm exec prisma migrate diff \
  --from-migrations prisma/migrations \
  --to-schema prisma/schema.prisma \
  --script --exit-code > "$DRIFT_SQL" 2>"$DRIFT_ERR"
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
    sed 's/^/  /' "$DRIFT_SQL" >&2
    echo >&2
    echo "Fix it by generating a migration:" >&2
    echo "  cd packages/db && pnpm exec prisma migrate dev --name <describe-the-change>" >&2
    exit 1
    ;;
  *)
    echo "!!! could not run the drift check" >&2
    cat "$DRIFT_ERR" >&2
    echo >&2
    echo "It needs a reachable PostgreSQL for the shadow database:" >&2
    echo "  $SHADOW_URL" >&2
    echo "Start the dev stack (scripts/dev.sh) or set ASCIIDOCOLLAB_SHADOW_DATABASE_URL." >&2
    exit 1
    ;;
esac
