#!/usr/bin/env bash
# Local end-to-end tests against a fully ISOLATED stack.
#
# Unlike scripts/ci/e2e.sh — which targets the shared dev compose and runs a
# destructive `prisma db push --force-reset` on it — this script spins up a
# SEPARATE Postgres + Mailpit (docker/docker-compose.e2e.yml, distinct ports and
# Compose project) and runs the API and web on distinct ports against a
# throwaway database. It never touches your development containers or data.
#
# Because the database is fresh and empty every run, only a plain `prisma db
# push` is needed (no `--force-reset`).
#
# Usage:  scripts/ci/e2e-local.sh        (or: pnpm e2e:local)
# Override a clashing port:  E2E_WEB_PORT=3200 scripts/ci/e2e-local.sh
set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; CYAN='\033[0;36m'; RESET='\033[0m'
step() { echo -e "${CYAN}[e2e-local]${RESET} $*"; }
ok()   { echo -e "${GREEN}[e2e-local]${RESET} $*"; }
die()  { echo -e "${RED}[e2e-local]${RESET} $*" >&2; exit 1; }

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

# Restore the terminal on exit in case a child left it in a raw/TUI mode, and
# stop spawned server process trees cleanly (no orphaned next-server, etc.).
source "$ROOT/scripts/lib/term.sh"
source "$ROOT/scripts/lib/proc.sh"
term_save

command -v docker &>/dev/null || die "Docker is required."

# ─── Isolated configuration (override via env if a port clashes) ─────────────
COMPOSE="docker compose -f $ROOT/docker/docker-compose.e2e.yml"
PG_PORT="${E2E_PG_PORT:-5433}"
SMTP_PORT="${E2E_SMTP_PORT:-1126}"
MAILPIT_UI_PORT="${E2E_MAILPIT_UI_PORT:-8126}"
API_PORT="${E2E_API_PORT:-4100}"
WEB_PORT="${E2E_WEB_PORT:-3100}"

# Isolate from a running dev stack (scripts/dev.sh): the API also binds an
# internal collab port (default 4001, already held by the dev API), so offset it.
# The Next build dir needs no isolation: this script builds into apps/web/.next while
# dev.sh runs `next dev` against .next-dev (NEXT_DIST_DIR), so they cannot collide.
# They shared `.next` until it was found to wreck the dev server's incremental cache —
# see the distDir note in apps/web/next.config.js.
export ASCIIDOCOLLAB_COLLAB_INTERNAL_PORT="${E2E_COLLAB_INTERNAL_PORT:-4101}"
# Browser-facing collaboration WebSocket (offset from the dev default 4002).
COLLAB_PORT="${E2E_COLLAB_PORT:-4102}"
export ASCIIDOCOLLAB_COLLAB_PORT="$COLLAB_PORT"
export ASCIIDOCOLLAB_COLLAB_API_INTERNAL_URL="http://127.0.0.1:${ASCIIDOCOLLAB_COLLAB_INTERNAL_PORT}"
# Collab internal edit endpoint (offset from the default 4003) + the API's URL pointing at it, so a
# rename/move rewrites references in LIVE collaborative docs via the Yjs source of truth.
export ASCIIDOCOLLAB_COLLAB_INTERNAL_EDIT_PORT="${E2E_COLLAB_EDIT_PORT:-4103}"
export ASCIIDOCOLLAB_COLLAB_EDIT_URL="http://127.0.0.1:${ASCIIDOCOLLAB_COLLAB_INTERNAL_EDIT_PORT}"
# Shared file storage so the collab server's write-back is visible to the API's GET /content.
export ASCIIDOCOLLAB_STORAGE_PATH="${ASCIIDOCOLLAB_STORAGE_PATH:-$ROOT/.e2e-storage}"
# Empty allowlist disables the Origin check for the isolated local stack.
export ASCIIDOCOLLAB_COLLAB_ALLOWED_ORIGINS=""

export ASCIIDOCOLLAB_DATABASE_URL="postgresql://asciidocollab:asciidocollab@localhost:${PG_PORT}/asciidocollab_e2e"
export ASCIIDOCOLLAB_API_PORT="$API_PORT"
export ASCIIDOCOLLAB_API_HOST="0.0.0.0"
export ASCIIDOCOLLAB_API_FRONTEND_URL="http://localhost:${WEB_PORT}"
export ASCIIDOCOLLAB_API_CORS_ORIGINS="http://localhost:${WEB_PORT}"
# Test-only secrets — never used outside e2e. Encryption key is base64 of a 32-byte string.
export ASCIIDOCOLLAB_AUTH_SESSION_SECRET="e2e-local-session-secret-not-for-production"
export ASCIIDOCOLLAB_AUTH_SESSION_ENCRYPTION_KEY="Y2ktdGVzdC1lbmNyeXB0aW9uLWtleS0zMmJ5dGVzISE="
export ASCIIDOCOLLAB_AUTH_COOKIE_SECURE="false"
export ASCIIDOCOLLAB_AUTH_EMAIL_PROVIDER="smtp"
export ASCIIDOCOLLAB_AUTH_EMAIL_ENABLED="true"
export ASCIIDOCOLLAB_AUTH_EMAIL_FROM="noreply@asciidocollab.local"
export ASCIIDOCOLLAB_AUTH_SMTP_HOST="localhost"
export ASCIIDOCOLLAB_AUTH_SMTP_PORT="$SMTP_PORT"
# Raise rate limits — parallel Playwright workers all share one localhost IP.
export ASCIIDOCOLLAB_ADMIN_INVITE_RATE_LIMIT_MAX=500
export ASCIIDOCOLLAB_ADMIN_OPEN_REGISTRATION_RATE_LIMIT_MAX=10000
export ASCIIDOCOLLAB_AUTH_EMAIL_VERIFICATION_RATE_LIMIT_MAX=500
export ASCIIDOCOLLAB_AUTH_INVITATION_RATE_LIMIT_MAX=500
# The cross-document / outline suites set a project's main file many times; the default 50/hour is
# easily exceeded by the shared-IP workers (× CI retries), so raise it well above the suite's volume.
export ASCIIDOCOLLAB_PROJECT_MAIN_FILE_RATE_LIMIT_MAX=10000
# The render config and the extension catalogue are read on EVERY project page open (the editor
# layout, the theme settings and the options page each ask), so the suite makes hundreds of these
# reads. At the 120/hour default ~70% of them came back 429 — which is silent: the config simply
# arrives empty and the page shows unset values, so tests failed on assertions about saved settings
# rather than on anything that looked like rate limiting.
export ASCIIDOCOLLAB_PROJECT_RENDER_CONFIG_RATE_LIMIT_MAX=10000
export ASCIIDOCOLLAB_PROJECT_PDF_EXTENSIONS_RATE_LIMIT_MAX=10000
export ASCIIDOCOLLAB_PROJECT_PDF_EXTENSIONS_SOURCE_RATE_LIMIT_MAX=10000

# PDF converter-extension drop folder. The default (/data/pdf-extensions) is a production bind mount
# that does not exist here, and a missing folder is deliberately the "no extensions offered" case —
# so without this the administrator-folder flow could never be exercised. The scan cache is dropped
# from 30s to 1s so `pdf-extensions.spec.ts` can add a directory and see the catalogue pick it up
# within one test rather than stalling a suite for half a minute per assertion.
export ASCIIDOCOLLAB_PROJECT_PDF_EXTENSIONS_PATH="${ASCIIDOCOLLAB_PROJECT_PDF_EXTENSIONS_PATH:-$ROOT/.e2e-pdf-extensions}"
export ASCIIDOCOLLAB_PROJECT_PDF_EXTENSIONS_SCAN_CACHE_TTL=1000
# Start from an empty folder: a leftover extension from a previous run would make the catalogue
# assertions depend on run history.
rm -rf "$ASCIIDOCOLLAB_PROJECT_PDF_EXTENSIONS_PATH"
mkdir -p "$ASCIIDOCOLLAB_PROJECT_PDF_EXTENSIONS_PATH"

# ─── Cleanup on exit ─────────────────────────────────────────────────────────
API_PID=""; WEB_PID=""; COLLAB_PID=""
cleanup() {
  echo ""
  step "Tearing down isolated stack …"
  # Stop servers (and their children) while the DB is still up so the API can
  # shut down gracefully, then tear the containers down.
  stop_tree "$API_PID"
  stop_tree "$COLLAB_PID"
  stop_tree "$WEB_PID"
  $COMPOSE down -v --remove-orphans 2>/dev/null || true
  term_restore
}
trap cleanup EXIT INT TERM

# ─── Fresh infrastructure ────────────────────────────────────────────────────
step "Starting isolated PostgreSQL + Mailpit (host ports ${PG_PORT} / ${SMTP_PORT} / ${MAILPIT_UI_PORT}) …"
$COMPOSE down -v --remove-orphans 2>/dev/null || true
$COMPOSE up -d --wait
ok "Infrastructure ready."

# ─── Build backend ───────────────────────────────────────────────────────────
step "Building backend packages …"
pnpm --filter '!@asciidocollab/web' -r build

step "Creating schema on the throwaway database (plain db push) …"
pnpm --filter @asciidocollab/db exec prisma db push

# ─── API ─────────────────────────────────────────────────────────────────────
# Both servers inherit the single shared ASCIIDOCOLLAB_STORAGE_PATH exported above.
# (Divergent storage is exercised separately by scripts/system-tests/assert-storage-guard.sh,
# which asserts the collab server fails fast rather than corrupting data.)
step "Starting API on :${API_PORT} …"
node "$ROOT/apps/api/dist/index.js" &
API_PID=$!
step "Waiting for API …"
until curl -sf "http://localhost:${API_PORT}/health" &>/dev/null; do sleep 1; done
ok "API is ready."

# ─── Collaboration server ────────────────────────────────────────────────────
step "Starting collaboration server on :${COLLAB_PORT} …"
node "$ROOT/apps/collab/dist/index.js" &
COLLAB_PID=$!
step "Waiting for collab server …"
# The collab server is a raw WebSocket endpoint (no HTTP /health), so probe the TCP port.
until (exec 3<>"/dev/tcp/127.0.0.1/${COLLAB_PORT}") 2>/dev/null; do sleep 1; done
exec 3>&- 2>/dev/null || true
ok "Collab server is ready."

# ─── Web ─────────────────────────────────────────────────────────────────────
# E2E_WEB_DEV=1 runs the web with `next dev` (the scripts/dev.sh code path: React
# Strict Mode double-invokes effects, NEXT_PUBLIC_* are read at runtime) instead
# of a production `next build` + `next start`. This exercises collaboration the
# same way a real developer running scripts/dev.sh does.
if [[ "${E2E_WEB_DEV:-}" == "1" ]]; then
  step "Starting Next.js in DEV mode (next dev) on :${WEB_PORT} (mirrors scripts/dev.sh) …"
  NEXT_PUBLIC_API_URL="http://localhost:${API_PORT}" \
  NEXT_PUBLIC_COLLAB_URL="ws://localhost:${COLLAB_PORT}" \
  PORT="$WEB_PORT" pnpm --filter @asciidocollab/web dev &
  WEB_PID=$!
else
  step "Building Next.js (API → :${API_PORT}, collab → :${COLLAB_PORT}) …"
  NEXT_PUBLIC_API_URL="http://localhost:${API_PORT}" \
  NEXT_PUBLIC_COLLAB_URL="ws://localhost:${COLLAB_PORT}" \
    pnpm --filter @asciidocollab/web build

  step "Starting Next.js on :${WEB_PORT} …"
  NEXT_PUBLIC_API_URL="http://localhost:${API_PORT}" \
  NEXT_PUBLIC_COLLAB_URL="ws://localhost:${COLLAB_PORT}" \
  PORT="$WEB_PORT" pnpm --filter @asciidocollab/web start &
  WEB_PID=$!
fi
step "Waiting for web …"
until curl -sf "http://localhost:${WEB_PORT}" &>/dev/null; do sleep 1; done
# `next dev` compiles routes lazily on first request; warm the editor route so the
# first Playwright navigation does not race the initial (slow) compile.
if [[ "${E2E_WEB_DEV:-}" == "1" ]]; then
  step "Warming dev routes (lazy compile) …"
  curl -sf "http://localhost:${WEB_PORT}/dashboard" &>/dev/null || true
fi
ok "Web is ready."

# ─── E2E suite ───────────────────────────────────────────────────────────────
# Optionally filter to a subset of spec files (e.g. E2E_FILES=collab- for the
# collaboration specs only); Playwright treats positional args as filename filters.
#
# CI=1 is set ONLY for the Playwright run (not the whole script) so the local gate matches CI's
# retry policy: the config sets `retries: process.env.CI ? 2 : 0`, and a handful of collaboration /
# preview / outline specs are timing-sensitive under the default 4 parallel workers sharing one
# Postgres + collab server — they pass on a retry, exactly as they do in CI. Scoping CI to this one
# command avoids changing the behaviour of the earlier build steps. (To see raw, un-retried results
# when hunting a genuine failure, run the spec directly with `npx playwright test` and CI unset.)
step "Running Playwright E2E tests …"
# Prefer IPv4 when resolving `localhost`. The stack's API/web/collab ports are published by Docker on
# IPv4 only, but on a dual-stack host `localhost` can resolve to `::1` first — Playwright's
# apiRequestContext then hits `::1:${API_PORT}` and gets ECONNREFUSED (no IPv4 fallback), which
# cascades to every spec's API setup once it happens. `--dns-result-order=ipv4first` pins resolution
# to the published family (matches the `127.0.0.1` internal URLs above).
CI=1 \
NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--dns-result-order=ipv4first" \
NEXT_PUBLIC_API_URL="http://localhost:${API_PORT}" \
NEXT_PUBLIC_WEB_URL="http://localhost:${WEB_PORT}" \
NEXT_PUBLIC_COLLAB_URL="ws://localhost:${COLLAB_PORT}" \
MAILPIT_URL="http://localhost:${MAILPIT_UI_PORT}" \
  pnpm --filter @asciidocollab/web e2e ${E2E_FILES:+-- "$E2E_FILES"}

ok "E2E suite passed — isolated stack, dev data untouched."
