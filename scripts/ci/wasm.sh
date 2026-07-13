#!/usr/bin/env bash
# Job 6 — Build the client-side Asciidoctor-PDF WebAssembly engine.
#
# The 69MB engine is gitignored and re-synced from the pinned Gemfile.lock via the ruby.wasm
# toolchain. This environment (CI runner and most dev machines) has Docker but NO host ruby / rbwasm /
# wasi-vfs, so the build MUST run inside the pinned toolchain container — build-wasm.docker.sh builds
# that image and runs the compile inside it, emitting asciidoctor-pdf.wasm back next to its Gemfile.
#
# This is a heavy job (downloads wasi-sdk + compiles CRuby → wasm), so in CI it is gated to run only
# when the wasm inputs (packages/asciidoc-pdf/ruby/**) change. Locally it is opt-in: `pnpm gate` skips
# it by default (see gate.sh) — run it directly (`pnpm wasm` / scripts/ci/wasm.sh) after touching the
# gem closure or the build toolchain.
set -euo pipefail

CYAN='\033[0;36m'; GREEN='\033[0;32m'; RED='\033[0;31m'; RESET='\033[0m'
step() { echo -e "${CYAN}[ci-wasm]${RESET} $*"; }
ok()   { echo -e "${GREEN}[ci-wasm]${RESET} $*"; }
die()  { echo -e "${RED}[ci-wasm]${RESET} $*" >&2; exit 1; }

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

command -v docker &>/dev/null || die "Docker is required to build the wasm engine (no host ruby toolchain)."

step "Building Asciidoctor-PDF wasm engine via the pinned ruby.wasm Docker toolchain …"
bash "$ROOT/packages/asciidoc-pdf/ruby/build-wasm.docker.sh"

OUTPUT="$ROOT/packages/asciidoc-pdf/ruby/asciidoctor-pdf.wasm"
[ -s "$OUTPUT" ] || die "Build reported success but $OUTPUT is missing or empty."
ok "wasm engine built: $OUTPUT ($(du -h "$OUTPUT" | cut -f1))."
