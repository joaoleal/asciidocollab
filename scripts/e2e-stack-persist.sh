#!/usr/bin/env bash
# Bring up the ISOLATED e2e stack (Postgres + Mailpit + API + COLLAB + web) and keep it running so
# targeted Playwright specs can be run against it deterministically (`--workers=1`) from another shell.
# Mirrors scripts/ci/e2e-local.sh's stack setup (including the collaboration server, which the original
# e2e-stack-up.sh omits) but never runs the suite and never tears down until interrupted.
set -euo pipefail

CYAN='\033[0;36m'; RESET='\033[0m'
step() { echo -e "${CYAN}[e2e-persist]${RESET} $*"; }

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Absolute path to this script, resolved BEFORE the `cd`: the stack lock
# re-invokes it, and $BASH_SOURCE is relative to the caller's directory.
SELF="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
cd "$ROOT"
source "$ROOT/scripts/lib/term.sh"; source "$ROOT/scripts/lib/proc.sh"
source "$ROOT/scripts/lib/e2e-lock.sh"; term_save

# ─── One owner of the isolated stack ─────────────────────────────────────────
# The stack lives exactly as long as this process (it stays in the foreground and
# tears down on exit), so holding the lock for this process's lifetime is the
# right scope. Without it scripts/ci/e2e-local.sh would begin by destroying the
# stack a developer is iterating against. Invariant: scripts/lib/e2e-lock.sh.
e2e_lock_guard "e2e-stack-persist" "$SELF" "$@"

# Refuse to destroy a stack whose owner is still alive (see e2e-lock.sh). FIRST,
# ahead of everything this run destroys or creates — it used to sit below the
# `rm -rf` of the PDF extension drop folder, so a run that would correctly refuse
# had already deleted a live run's directory on the way to saying no. A refusal
# must leave the other run untouched. (Still before the EXIT trap, which runs
# `down -v` too — refusing afterwards would destroy on the way out the stack we
# just declined to touch.) Nothing destructive belongs above this line.
e2e_assert_stack_not_in_use "e2e-stack-persist"

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
# Match scripts/ci/e2e-local.sh: the per-user connect rate limit (default 120/min) throttles the
# suite's shared account and leaves the editor empty. See the comment there.
export ASCIIDOCOLLAB_COLLAB_CONNECT_RATE_PER_MIN="${ASCIIDOCOLLAB_COLLAB_CONNECT_RATE_PER_MIN:-10000}"
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

# Stamp this run's identity onto the containers we are about to create. (The
# refusal check itself runs at the top of the script, ahead of every destructive
# step.)
e2e_export_stack_owner "e2e-stack-persist"

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
