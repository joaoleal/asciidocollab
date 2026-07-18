#!/usr/bin/env bash
# Bring up the ISOLATED e2e stack (Postgres + Mailpit + API + COLLAB + web) and keep it running so
# targeted Playwright specs can be run against it deterministically (`--workers=1`) from another shell.
# Mirrors scripts/ci/e2e-local.sh's stack setup (including the collaboration server, which the original
# e2e-stack-up.sh omits) but never runs the suite and never tears down until interrupted.
set -euo pipefail

CYAN='\033[0;36m'; RESET='\033[0m'
step() { echo -e "${CYAN}[e2e-persist]${RESET} $*"; }

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
source "$ROOT/scripts/lib/term.sh"; source "$ROOT/scripts/lib/proc.sh"; term_save

COMPOSE="docker compose -f $ROOT/docker/docker-compose.e2e.yml"
PG_PORT="${E2E_PG_PORT:-5433}"; SMTP_PORT="${E2E_SMTP_PORT:-1126}"; MAILPIT_UI_PORT="${E2E_MAILPIT_UI_PORT:-8126}"
API_PORT="${E2E_API_PORT:-4100}"; WEB_PORT="${E2E_WEB_PORT:-3100}"; COLLAB_PORT="${E2E_COLLAB_PORT:-4102}"

export ASCIIDOCOLLAB_COLLAB_INTERNAL_PORT="${E2E_COLLAB_INTERNAL_PORT:-4101}"
export ASCIIDOCOLLAB_COLLAB_PORT="$COLLAB_PORT"
export ASCIIDOCOLLAB_COLLAB_API_INTERNAL_URL="http://127.0.0.1:${ASCIIDOCOLLAB_COLLAB_INTERNAL_PORT}"
export ASCIIDOCOLLAB_COLLAB_INTERNAL_EDIT_PORT="${E2E_COLLAB_EDIT_PORT:-4103}"
export ASCIIDOCOLLAB_COLLAB_EDIT_URL="http://127.0.0.1:${ASCIIDOCOLLAB_COLLAB_INTERNAL_EDIT_PORT}"
export ASCIIDOCOLLAB_STORAGE_PATH="${ASCIIDOCOLLAB_STORAGE_PATH:-$ROOT/.e2e-storage}"
export ASCIIDOCOLLAB_COLLAB_ALLOWED_ORIGINS=""
export ASCIIDOCOLLAB_DATABASE_URL="postgresql://asciidocollab:asciidocollab@localhost:${PG_PORT}/asciidocollab_e2e"
export ASCIIDOCOLLAB_API_PORT="$API_PORT"; export ASCIIDOCOLLAB_API_HOST="0.0.0.0"
export ASCIIDOCOLLAB_API_FRONTEND_URL="http://localhost:${WEB_PORT}"
export ASCIIDOCOLLAB_API_CORS_ORIGINS="http://localhost:${WEB_PORT}"
export ASCIIDOCOLLAB_AUTH_SESSION_SECRET="e2e-local-session-secret-not-for-production"
export ASCIIDOCOLLAB_AUTH_SESSION_ENCRYPTION_KEY="Y2ktdGVzdC1lbmNyeXB0aW9uLWtleS0zMmJ5dGVzISE="
export ASCIIDOCOLLAB_AUTH_COOKIE_SECURE="false"
export ASCIIDOCOLLAB_AUTH_EMAIL_PROVIDER="smtp"; export ASCIIDOCOLLAB_AUTH_EMAIL_ENABLED="true"
export ASCIIDOCOLLAB_AUTH_EMAIL_FROM="noreply@asciidocollab.local"
export ASCIIDOCOLLAB_AUTH_SMTP_HOST="localhost"; export ASCIIDOCOLLAB_AUTH_SMTP_PORT="$SMTP_PORT"
export ASCIIDOCOLLAB_ADMIN_INVITE_RATE_LIMIT_MAX=500
export ASCIIDOCOLLAB_ADMIN_OPEN_REGISTRATION_RATE_LIMIT_MAX=10000
export ASCIIDOCOLLAB_AUTH_EMAIL_VERIFICATION_RATE_LIMIT_MAX=500
export ASCIIDOCOLLAB_AUTH_INVITATION_RATE_LIMIT_MAX=500
export ASCIIDOCOLLAB_PROJECT_MAIN_FILE_RATE_LIMIT_MAX=10000

API_PID=""; WEB_PID=""; COLLAB_PID=""
cleanup() {
  step "Tearing down …"
  stop_tree "$API_PID"; stop_tree "$COLLAB_PID"; stop_tree "$WEB_PID"
  $COMPOSE down -v --remove-orphans 2>/dev/null || true
  term_restore
}
trap cleanup EXIT INT TERM

step "Starting Postgres + Mailpit …"
$COMPOSE down -v --remove-orphans 2>/dev/null || true
$COMPOSE up -d --wait

step "Building backend …"
pnpm --filter '!@asciidocollab/web' -r build
step "Schema push …"
pnpm --filter @asciidocollab/db exec prisma db push

step "Starting API on :${API_PORT} …"
node "$ROOT/apps/api/dist/index.js" & API_PID=$!
until curl -sf "http://localhost:${API_PORT}/health" &>/dev/null; do sleep 1; done
step "API ready."

step "Starting collab on :${COLLAB_PORT} …"
node "$ROOT/apps/collab/dist/index.js" & COLLAB_PID=$!
until (exec 3<>"/dev/tcp/127.0.0.1/${COLLAB_PORT}") 2>/dev/null; do sleep 1; done
exec 3>&- 2>/dev/null || true
step "Collab ready."

step "Building web …"
NEXT_PUBLIC_API_URL="http://localhost:${API_PORT}" NEXT_PUBLIC_COLLAB_URL="ws://localhost:${COLLAB_PORT}" \
  pnpm --filter @asciidocollab/web build

step "Starting web on :${WEB_PORT} …"
NEXT_PUBLIC_API_URL="http://localhost:${API_PORT}" NEXT_PUBLIC_COLLAB_URL="ws://localhost:${COLLAB_PORT}" \
  PORT="$WEB_PORT" pnpm --filter @asciidocollab/web start & WEB_PID=$!
until curl -sf "http://localhost:${WEB_PORT}" &>/dev/null; do sleep 1; done

echo "STACK_READY api=http://localhost:${API_PORT} web=http://localhost:${WEB_PORT} collab=ws://localhost:${COLLAB_PORT}"
step "Stack up. Ctrl-C to tear down."
wait
