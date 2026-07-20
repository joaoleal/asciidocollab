#!/usr/bin/env bash
set -euo pipefail

# ─── Colours ─────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; RESET='\033[0m'

info()    { echo -e "${CYAN}[dev]${RESET} $*"; }
success() { echo -e "${GREEN}[dev]${RESET} $*"; }
warn()    { echo -e "${YELLOW}[dev]${RESET} $*"; }
die()     { echo -e "${RED}[dev]${RESET} $*" >&2; exit 1; }

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Capture a sane terminal snapshot up front so cleanup can restore it after a
# TUI child (next dev) leaves it in raw / application cursor-key mode, and load
# the process-tree stop helper so cleanup leaves no orphaned next-server, etc.
source "$ROOT/scripts/lib/term.sh"
source "$ROOT/scripts/lib/proc.sh"
term_save

# ─── Prerequisites ────────────────────────────────────────────────────────────
check_cmd() { command -v "$1" &>/dev/null || die "Required command not found: $1. See README for install instructions."; }
check_cmd node
check_cmd pnpm
check_cmd docker

node -e "process.exit(parseInt(process.versions.node) < 24 ? 1 : 0)" 2>/dev/null \
  || die "Node.js 24+ is required. Found: $(node --version)"

# ─── Env file ─────────────────────────────────────────────────────────────────
ENV_FILE="$ROOT/.env.local"

if [[ ! -f "$ENV_FILE" ]]; then
  info "Creating .env.local from .env.example …"
  cp "$ROOT/.env.example" "$ENV_FILE"

  # Auto-generate secrets so the app starts without manual intervention
  SESSION_SECRET=$(openssl rand -base64 32)
  ENCRYPTION_KEY=$(openssl rand -base64 32)

  if [[ "$OSTYPE" == "darwin"* ]]; then
    sed -i '' "s|ASCIIDOCOLLAB_AUTH_SESSION_SECRET=CHANGE_ME|ASCIIDOCOLLAB_AUTH_SESSION_SECRET=${SESSION_SECRET}|" "$ENV_FILE"
    sed -i '' "s|ASCIIDOCOLLAB_AUTH_SESSION_ENCRYPTION_KEY=CHANGE_ME|ASCIIDOCOLLAB_AUTH_SESSION_ENCRYPTION_KEY=${ENCRYPTION_KEY}|" "$ENV_FILE"
  else
    sed -i "s|ASCIIDOCOLLAB_AUTH_SESSION_SECRET=CHANGE_ME|ASCIIDOCOLLAB_AUTH_SESSION_SECRET=${SESSION_SECRET}|" "$ENV_FILE"
    sed -i "s|ASCIIDOCOLLAB_AUTH_SESSION_ENCRYPTION_KEY=CHANGE_ME|ASCIIDOCOLLAB_AUTH_SESSION_ENCRYPTION_KEY=${ENCRYPTION_KEY}|" "$ENV_FILE"
  fi

  success ".env.local created with auto-generated secrets."
else
  info "Using existing .env.local"
fi

# Source env file
set -a; source "$ENV_FILE"; set +a

# ─── Shared collaboration storage (CRITICAL) ──────────────────────────────────
# The API and the collaboration server BOTH read and write project files. The
# collab server owns persistence while a document is open (write-back on edit and
# room teardown); the API serves GET /content, downloads, and previews from the
# same files. If the two processes use different storage roots they silently
# diverge: collaborative edits never reach the REST source of truth, downloads and
# other clients see stale content, and REST writes overwrite collaborative edits
# (and vice-versa) — i.e. users see different things and clobber each other.
#
# Each server defaults `storagePath` to a CWD-relative "./storage". Because we
# start them from their own app directories below (apps/api, apps/collab), that
# default would resolve to two DIFFERENT directories. Pin a single ABSOLUTE root
# here so both processes share it regardless of CWD. (Respects an explicit
# override from .env.local if the operator set one.)
export ASCIIDOCOLLAB_STORAGE_PATH="${ASCIIDOCOLLAB_STORAGE_PATH:-$ROOT/.dev-storage}"
info "Shared file storage: $ASCIIDOCOLLAB_STORAGE_PATH"

# The browser connects to the collaboration WebSocket directly. Pin it so a
# .env.local generated before the collaboration feature existed still works.
export NEXT_PUBLIC_COLLAB_URL="${NEXT_PUBLIC_COLLAB_URL:-ws://localhost:${ASCIIDOCOLLAB_COLLAB_PORT:-4002}}"

# ─── Docker services ──────────────────────────────────────────────────────────
# --wait blocks until all services with healthchecks report healthy.
# For postgres this means the DB and the asciidocollab database both exist,
# because the official postgres image only accepts connections after its
# POSTGRES_DB initialisation script has run.
info "Starting infrastructure services (PostgreSQL + Mailpit) …"
docker compose -f "$ROOT/docker/docker-compose.dev.yml" up -d --wait
success "PostgreSQL is ready."

# ─── Dependencies ─────────────────────────────────────────────────────────────
info "Installing dependencies …"
pnpm install --frozen-lockfile

# ─── Build ────────────────────────────────────────────────────────────────────
# Deliberately NOT `pnpm build` (= `pnpm -r build`). That would include apps/web's
# `next build` — a full PRODUCTION build — whose output this script then throws
# away, because it starts `next dev` below and Next compiles on demand in dev.
#
# Worse than wasteful: `next build`'s static-generation stage spawns a jest-worker
# pool sized to the machine's core count (24 cores → "Collecting page data using 23
# workers"), and each child loads the whole app module graph. On a many-core box the
# pool has repeatedly grown unbounded here — 588 node processes / 21.7 GB observed —
# until the kernel OOM-killer fired and took desktop apps down with it.
#
# So: build every workspace project EXCEPT the web app, then run only the web app's
# `prebuild`. prebuild is still required — it generates assets `next dev` needs at
# runtime (the wasm engine copies, MathJax/pdf.js vendor assets, Hunspell
# dictionaries and the generated lezer parser). It is normally an implicit npm
# lifecycle hook of `build`, so skipping `build` means invoking it explicitly.
info "Building packages …"
pnpm -r --filter '!@asciidocollab/web' build

info "Preparing web app assets …"
pnpm --filter @asciidocollab/web run prebuild

# ─── Database schema ──────────────────────────────────────────────────────────
# ASCIIDOCOLLAB_DATABASE_URL is already exported from the sourced env file.
# prisma.config.ts reads it and passes it as the datasource URL.
info "Applying database schema …"
(cd "$ROOT/packages/db" && pnpm exec prisma db push)
success "Database schema applied."

# ─── Process cleanup on exit ──────────────────────────────────────────────────
API_PID=""
COLLAB_PID=""
WEB_PID=""

_cleaned=0
cleanup() {
  # Guard against running twice (the INT trap fires, then the EXIT trap fires
  # again as the script unwinds).
  [[ "$_cleaned" == 1 ]] && return 0
  _cleaned=1
  trap '' INT TERM   # ignore further Ctrl-C while shutting down
  echo ""
  info "Shutting down …"
  # Stop each server and its children (stop_tree blocks until they exit, so the
  # terminal is free to restore and no next-server is left orphaned).
  stop_tree "$API_PID"
  stop_tree "$COLLAB_PID"
  stop_tree "$WEB_PID"
  term_restore
  info "Stopped. Docker services are still running — stop them with: docker compose -f docker/docker-compose.dev.yml down"
}
trap cleanup EXIT INT TERM

# ─── Start services ───────────────────────────────────────────────────────────
API_PORT="${ASCIIDOCOLLAB_API_PORT:-4000}"
INTERNAL_PORT="${ASCIIDOCOLLAB_COLLAB_INTERNAL_PORT:-4001}"

info "Starting API server …"
(cd "$ROOT/apps/api" && NODE_ENV=development node dist/index.js) &
API_PID=$!

# Wait for the API BEFORE starting the collab server. The collab server runs a
# startup storage-consistency check (and per-connection auth) against the API's
# internal port; starting it before the API is listening makes that check fail.
info "Waiting for the API (:$API_PORT public, :$INTERNAL_PORT internal) …"
until curl -sf "http://localhost:${API_PORT}/health" &>/dev/null; do
  kill -0 "$API_PID" 2>/dev/null || die "API exited before becoming ready — see output above."
  sleep 0.5
done
until (exec 3<>"/dev/tcp/127.0.0.1/${INTERNAL_PORT}") 2>/dev/null; do
  kill -0 "$API_PID" 2>/dev/null || die "API exited before its internal server came up — see output above."
  sleep 0.5
done
exec 3>&- 2>/dev/null || true
success "API is ready."

info "Starting collab server …"
(cd "$ROOT/apps/collab" && NODE_ENV=development node dist/index.js) &
COLLAB_PID=$!

# NEXT_DIST_DIR keeps the dev server's Turbopack cache out of `.next`, which every build path
# (pnpm gate, the e2e scripts, CI) fills with a PRODUCTION build. Sharing one directory let a build
# rewrite .next/server + .next/static under the live dev cache; the next page compile then
# re-transformed everything, spawning 200 postcss child processes and 12.5 GB before finishing. Set
# inline rather than exported, so only `next dev` sees it and every build still targets `.next`.
info "Starting web app …"
(cd "$ROOT/apps/web" && NEXT_DIST_DIR=.next-dev pnpm dev) &
WEB_PID=$!

echo ""
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
echo -e "  ${GREEN}AsciiDoCollab is running${RESET}"
echo ""
echo -e "  Web app   →  ${CYAN}http://localhost:3000${RESET}"
echo -e "  API       →  ${CYAN}http://localhost:4000${RESET}"
echo -e "  Collab    →  ${CYAN}ws://localhost:${ASCIIDOCOLLAB_COLLAB_PORT:-4002}${RESET}"
echo -e "  API docs  →  ${CYAN}http://localhost:4000/documentation${RESET}"
echo -e "  Email UI  →  ${CYAN}http://localhost:8025${RESET}  (captured emails)"
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
echo ""
echo -e "  Press ${YELLOW}Ctrl+C${RESET} to stop the app servers."
echo -e "  Run ${YELLOW}docker compose -f docker/docker-compose.dev.yml down${RESET} to also stop the database."
echo ""

wait "$API_PID" "$COLLAB_PID" "$WEB_PID"
