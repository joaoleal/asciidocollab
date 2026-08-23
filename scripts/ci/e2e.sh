#!/usr/bin/env bash
# Job 4 — End-to-end tests (Playwright). Requires Docker for PostgreSQL + Mailpit.
#
# Rate-limit overrides are forced below regardless of .env.local. The production
# defaults (e.g. 10 invite accepts/hour) are too low for 12 parallel Playwright
# workers all sharing the same localhost IP — without them the suite hits 429 errors.
set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; CYAN='\033[0;36m'; RESET='\033[0m'
step() { echo -e "${CYAN}[ci-e2e]${RESET} $*"; }
ok()   { echo -e "${GREEN}[ci-e2e]${RESET} $*"; }
die()  { echo -e "${RED}[ci-e2e]${RESET} $*" >&2; exit 1; }

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

# Restore the terminal on exit in case a child left it in a raw/TUI mode, and
# stop spawned server process trees cleanly (no orphaned next-server, etc.).
source "$ROOT/scripts/lib/term.sh"
source "$ROOT/scripts/lib/proc.sh"
term_save

# ─── Prerequisites ────────────────────────────────────────────────────────────
command -v docker &>/dev/null || die "Docker is required."

# ─── Env file ────────────────────────────────────────────────────────────────
# Source .env.local for database URL, session secrets, and SMTP settings.
ENV_FILE="$ROOT/.env.local"
if [[ -f "$ENV_FILE" ]]; then
  set -a; source "$ENV_FILE"; set +a
else
  die ".env.local not found. Copy .env.example and fill in required values, or run scripts/dev.sh first."
fi

# Force rate-limit overrides — these must be set regardless of .env.local content.
export ASCIIDOCOLLAB_ADMIN_INVITE_RATE_LIMIT_MAX=500
export ASCIIDOCOLLAB_ADMIN_OPEN_REGISTRATION_RATE_LIMIT_MAX=10000
export ASCIIDOCOLLAB_AUTH_EMAIL_VERIFICATION_RATE_LIMIT_MAX=500
export ASCIIDOCOLLAB_AUTH_INVITATION_RATE_LIMIT_MAX=500
# Outline / cross-document suites set a project's main file many times; raise the 50/hour default.
export ASCIIDOCOLLAB_PROJECT_MAIN_FILE_RATE_LIMIT_MAX=10000
# Project cloning is budgeted at 20 per HOUR in production, and the window does not reset inside a
# run: the clone spec spends six of them per pass, so two attempts plus a retried failure sit right
# on the ceiling, and a second run within the hour starts already over it. A 429 there is silent in
# the same way the render-config one was — the dialog reports "too many clones recently" and the test
# fails on an assertion about the copy that was never made.
export ASCIIDOCOLLAB_PROJECT_CLONE_RATE_LIMIT_MAX=10000

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
API_PID=""; WEB_PID=""
cleanup() {
  echo ""
  step "Shutting down servers …"
  stop_tree "$API_PID"
  stop_tree "$WEB_PID"
  term_restore
}
trap cleanup EXIT INT TERM

# ─── Infrastructure ──────────────────────────────────────────────────────────
step "Starting PostgreSQL and Mailpit …"
docker compose -f "$ROOT/docker/docker-compose.dev.yml" up -d postgres mailpit --wait

# ─── Build ───────────────────────────────────────────────────────────────────
step "Building shared packages …"
pnpm --filter '!@asciidocollab/web' -r build

step "Applying database schema (force-reset for a clean slate) …"
pnpm --filter @asciidocollab/db exec prisma db push --force-reset

# ─── API ─────────────────────────────────────────────────────────────────────
step "Starting API server …"
node apps/api/dist/index.js &
API_PID=$!

step "Waiting for API …"
until curl -sf http://localhost:4000/health &>/dev/null; do sleep 1; done
ok "API is ready."

# ─── Web ─────────────────────────────────────────────────────────────────────
step "Building Next.js …"
NEXT_PUBLIC_API_URL=http://localhost:4000 pnpm --filter @asciidocollab/web build

step "Starting Next.js …"
NEXT_PUBLIC_API_URL=http://localhost:4000 pnpm --filter @asciidocollab/web start &
WEB_PID=$!

step "Waiting for web …"
until curl -sf http://localhost:3000 &>/dev/null; do sleep 1; done
ok "Web is ready."

# ─── E2E suite ───────────────────────────────────────────────────────────────
step "Running Playwright E2E tests …"
NEXT_PUBLIC_API_URL=http://localhost:4000 \
NEXT_PUBLIC_WEB_URL=http://localhost:3000 \
MAILPIT_URL=http://localhost:8025 \
  pnpm --filter @asciidocollab/web e2e

ok "E2E suite passed."
