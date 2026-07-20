#!/usr/bin/env bash
# Local pre-merge gate runner — runs the CI jobs in order and stops on the first
# failure. Two are opt-in because they are slow: RUN_WASM=1 (the CRuby→wasm
# engine compile) and RUN_DOCKER=1 (the production image build).
#
# The e2e job uses scripts/ci/e2e-local.sh (a fully ISOLATED stack: its own
# containers, ports 4100/3100/5433, collab-internal 4101, and a throwaway
# database) rather than scripts/ci/e2e.sh. e2e.sh is the CI form: it targets
# the shared dev stack and runs `prisma db push --force-reset`, so it would
# EADDRINUSE on the dev ports (4000/3000) and wipe your dev database. Using
# e2e-local.sh here means you can run the whole gate while scripts/dev.sh is up
# without touching your dev containers, ports, or data.
#
# Safe to run alongside scripts/dev.sh. Every job runs `pnpm -r build`, which includes
# a web `next build` into apps/web/.next — but dev.sh points `next dev` at .next-dev
# (NEXT_DIST_DIR), so the two no longer share a directory. They used to, and it was not
# survivable: a production build rewrote .next/server and .next/static under the live
# Turbopack cache, whose next page compile then re-transformed everything — 200 postcss
# child processes and 12.5 GB, never finishing. See apps/web/next.config.js distDir.
#
# Usage:  pnpm gate            (or: scripts/ci/gate.sh)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

GREEN='\033[0;32m'; CYAN='\033[0;36m'; RESET='\033[0m'
gate() { echo -e "\n${CYAN}━━━ $* ━━━${RESET}"; }

gate "Job 1/8 — Quality (build · lint · types · architecture · audit)"
"$ROOT/scripts/ci/quality.sh"

gate "Job 2/8 — Unit tests + coverage"
"$ROOT/scripts/ci/unit.sh"

gate "Job 3/8 — Integration tests (Testcontainers)"
"$ROOT/scripts/ci/integration.sh"

gate "Job 4/8 — Security scan (SAST · secrets · dep CVEs · workflows · dead code)"
"$ROOT/scripts/ci/security.sh"

gate "Job 5/8 — E2E (isolated stack — safe alongside scripts/dev.sh)"
"$ROOT/scripts/ci/e2e-local.sh"

# Job 6 — PDF reference parity. Needs the wasm engine and poppler, so it is skipped (not failed) when
# either is absent locally; CI provisions both and runs it unconditionally, where a skip would be a
# green run that compared nothing.
if command -v pdftoppm &>/dev/null && [ -f "$ROOT/packages/asciidoc-pdf/ruby/asciidoctor-pdf.wasm" ]; then
  gate "Job 6/8 — PDF reference parity (in-app output vs the canonical toolchain)"
  "$ROOT/scripts/ci/pdf-parity.sh"
else
  gate "Job 6/8 — PDF reference parity — SKIPPED (needs poppler-utils and a built wasm engine)"
fi

# Job 7 — the client-side PDF wasm engine. In CI this job is gated to run ONLY when the wasm inputs
# (packages/asciidoc-pdf/ruby/**) change, because the CRuby→wasm compile is heavy (~15-25 min). The
# local gate mirrors that: it is OPT-IN so a routine `pnpm gate` stays fast. Run it (RUN_WASM=1 pnpm
# gate, or `pnpm wasm`) whenever you touch the gem closure or the build toolchain.
if [ "${RUN_WASM:-}" = "1" ]; then
  gate "Job 7/8 — PDF wasm engine build (RUN_WASM=1)"
  "$ROOT/scripts/ci/wasm.sh"
else
  gate "Job 7/8 — PDF wasm engine build — SKIPPED (set RUN_WASM=1 to build; CI runs it on ruby/** changes)"
fi

# Job 8 — the production Docker images. CI builds these on every run (a broken Dockerfile otherwise
# surfaces at deploy time), but the four targets compile the whole workspace, so locally this is
# OPT-IN to keep a routine `pnpm gate` fast. Run it (RUN_DOCKER=1 pnpm gate) when you touch
# docker/Dockerfile, the compose build args, or anything that changes how the workspace installs.
if [ "${RUN_DOCKER:-}" = "1" ]; then
  gate "Job 8/8 — Production image build (RUN_DOCKER=1)"
  "$ROOT/scripts/ci/docker.sh"
else
  gate "Job 8/8 — Production image build — SKIPPED (set RUN_DOCKER=1 to build; CI runs it every run)"
fi

echo -e "\n${GREEN}✓ All pre-merge gates passed.${RESET}"
