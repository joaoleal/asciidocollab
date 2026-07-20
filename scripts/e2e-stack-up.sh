#!/usr/bin/env bash
# Bring up the ISOLATED e2e stack (Postgres + Mailpit + API + web) and KEEP IT
# RUNNING in the foreground so targeted Playwright tests / screenshots can be run
# against it from another shell. Mirrors scripts/ci/e2e-local.sh but never runs the
# suite and never tears down until interrupted.
#
# Ports (override via env): PG 5433, SMTP 1126, Mailpit UI 8126, API 4100, web 3100.
set -euo pipefail

CYAN='\033[0;36m'; RESET='\033[0m'
step() { echo -e "${CYAN}[e2e-stack]${RESET} $*"; }

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# Restore the terminal on exit in case a child left it in a raw/TUI mode, and
# stop spawned server process trees cleanly (no orphaned next-server, etc.).
source "$ROOT/scripts/lib/term.sh"
source "$ROOT/scripts/lib/proc.sh"
term_save

COMPOSE="docker compose -f $ROOT/docker/docker-compose.e2e.yml"
PG_PORT="${E2E_PG_PORT:-5433}"
SMTP_PORT="${E2E_SMTP_PORT:-1126}"
MAILPIT_UI_PORT="${E2E_MAILPIT_UI_PORT:-8126}"
API_PORT="${E2E_API_PORT:-4100}"
WEB_PORT="${E2E_WEB_PORT:-3100}"

export ASCIIDOCOLLAB_DATABASE_URL="postgresql://asciidocollab:asciidocollab@localhost:${PG_PORT}/asciidocollab_e2e"
export ASCIIDOCOLLAB_API_PORT="$API_PORT"
# Internal collab port — offset from the API port so it never clashes with a
# stray dev API still holding the default 4001. (The `.next` build dir needs no
# isolation — dev.sh points `next dev` at .next-dev via NEXT_DIST_DIR, so a build
# here cannot disturb it. See the distDir note in apps/web/next.config.js.)
export ASCIIDOCOLLAB_COLLAB_INTERNAL_PORT="${E2E_COLLAB_INTERNAL_PORT:-4101}"
# Collab internal edit endpoint — offset from the default 4003 so it never clashes with a dev
# collab still holding it; the API reaches it via this URL to rewrite references in live docs.
export ASCIIDOCOLLAB_COLLAB_INTERNAL_EDIT_PORT="${E2E_COLLAB_EDIT_PORT:-4103}"
export ASCIIDOCOLLAB_COLLAB_EDIT_URL="http://127.0.0.1:${ASCIIDOCOLLAB_COLLAB_INTERNAL_EDIT_PORT}"
export ASCIIDOCOLLAB_API_HOST="0.0.0.0"
export ASCIIDOCOLLAB_API_FRONTEND_URL="http://localhost:${WEB_PORT}"
export ASCIIDOCOLLAB_API_CORS_ORIGINS="http://localhost:${WEB_PORT}"
export ASCIIDOCOLLAB_AUTH_SESSION_SECRET="e2e-local-session-secret-not-for-production"
export ASCIIDOCOLLAB_AUTH_SESSION_ENCRYPTION_KEY="Y2ktdGVzdC1lbmNyeXB0aW9uLWtleS0zMmJ5dGVzISE="
export ASCIIDOCOLLAB_AUTH_COOKIE_SECURE="false"
export ASCIIDOCOLLAB_AUTH_EMAIL_PROVIDER="smtp"
export ASCIIDOCOLLAB_AUTH_EMAIL_ENABLED="true"
export ASCIIDOCOLLAB_AUTH_EMAIL_FROM="noreply@asciidocollab.local"
export ASCIIDOCOLLAB_AUTH_SMTP_HOST="localhost"
export ASCIIDOCOLLAB_AUTH_SMTP_PORT="$SMTP_PORT"
export ASCIIDOCOLLAB_ADMIN_INVITE_RATE_LIMIT_MAX=500
export ASCIIDOCOLLAB_ADMIN_OPEN_REGISTRATION_RATE_LIMIT_MAX=10000
export ASCIIDOCOLLAB_AUTH_EMAIL_VERIFICATION_RATE_LIMIT_MAX=500
export ASCIIDOCOLLAB_AUTH_INVITATION_RATE_LIMIT_MAX=500
# Read on every project page open; the 120/hour default is far below what a suite run makes, and a
# 429 arrives as an empty config rather than a visible error.
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

API_PID=""; WEB_PID=""
cleanup() {
  step "Tearing down isolated stack …"
  stop_tree "$API_PID"
  stop_tree "$WEB_PID"
  $COMPOSE down -v --remove-orphans 2>/dev/null || true
  term_restore
}
trap cleanup EXIT INT TERM

step "Starting isolated PostgreSQL + Mailpit …"
$COMPOSE down -v --remove-orphans 2>/dev/null || true
$COMPOSE up -d --wait

step "Building backend packages …"
pnpm --filter '!@asciidocollab/web' -r build

step "Creating schema (prisma db push) …"
pnpm --filter @asciidocollab/db exec prisma db push

step "Starting API on :${API_PORT} …"
node "$ROOT/apps/api/dist/index.js" &
API_PID=$!
until curl -sf "http://localhost:${API_PORT}/health" &>/dev/null; do sleep 1; done
step "API ready."

step "Building Next.js (API → :${API_PORT}) …"
NEXT_PUBLIC_API_URL="http://localhost:${API_PORT}" pnpm --filter @asciidocollab/web build

step "Starting Next.js on :${WEB_PORT} …"
NEXT_PUBLIC_API_URL="http://localhost:${API_PORT}" PORT="$WEB_PORT" pnpm --filter @asciidocollab/web start &
WEB_PID=$!
until curl -sf "http://localhost:${WEB_PORT}" &>/dev/null; do sleep 1; done

echo "STACK_READY api=http://localhost:${API_PORT} web=http://localhost:${WEB_PORT} mailpit=http://localhost:${MAILPIT_UI_PORT}"
step "Stack is up. Ctrl-C to tear down."
wait
