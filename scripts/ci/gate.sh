#!/usr/bin/env bash
# Local pre-merge gate runner — runs all five CI jobs in order and stops on the
# first failure.
#
# The e2e job uses scripts/ci/e2e-local.sh (a fully ISOLATED stack: its own
# containers, ports 4100/3100/5433, collab-internal 4101, and a throwaway
# database) rather than scripts/ci/e2e.sh. e2e.sh is the CI form: it targets
# the shared dev stack and runs `prisma db push --force-reset`, so it would
# EADDRINUSE on the dev ports (4000/3000) and wipe your dev database. Using
# e2e-local.sh here means you can run the whole gate while scripts/dev.sh is up
# without touching your dev containers, ports, or data.
#
# Caveat: every job runs `pnpm -r build`, which includes a web `next build` into
# the shared apps/web/.next. A concurrently-running `next dev` will simply
# recompile afterwards; the dev DB and containers are unaffected.
#
# Usage:  pnpm gate            (or: scripts/ci/gate.sh)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

GREEN='\033[0;32m'; CYAN='\033[0;36m'; RESET='\033[0m'
gate() { echo -e "\n${CYAN}━━━ $* ━━━${RESET}"; }

gate "Job 1/6 — Quality (build · lint · types · architecture · audit)"
"$ROOT/scripts/ci/quality.sh"

gate "Job 2/6 — Unit tests + coverage"
"$ROOT/scripts/ci/unit.sh"

gate "Job 3/6 — Integration tests (Testcontainers)"
"$ROOT/scripts/ci/integration.sh"

gate "Job 4/6 — Security scan (SAST · secrets · dep CVEs · workflows · dead code)"
"$ROOT/scripts/ci/security.sh"

gate "Job 5/6 — E2E (isolated stack — safe alongside scripts/dev.sh)"
"$ROOT/scripts/ci/e2e-local.sh"

# Job 6 — the client-side PDF wasm engine. In CI this job is gated to run ONLY when the wasm inputs
# (packages/asciidoc-pdf/ruby/**) change, because the CRuby→wasm compile is heavy (~15-25 min). The
# local gate mirrors that: it is OPT-IN so a routine `pnpm gate` stays fast. Run it (RUN_WASM=1 pnpm
# gate, or `pnpm wasm`) whenever you touch the gem closure or the build toolchain.
if [ "${RUN_WASM:-}" = "1" ]; then
  gate "Job 6/6 — PDF wasm engine build (RUN_WASM=1)"
  "$ROOT/scripts/ci/wasm.sh"
else
  gate "Job 6/6 — PDF wasm engine build — SKIPPED (set RUN_WASM=1 to build; CI runs it on ruby/** changes)"
fi

echo -e "\n${GREEN}✓ All pre-merge gates passed.${RESET}"
