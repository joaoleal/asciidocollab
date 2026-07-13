#!/usr/bin/env bash
# Job 6 — Build the client-side Asciidoctor-PDF WebAssembly engine.
#
# The 69MB engine is gitignored and re-synced from the pinned Gemfile.lock via the ruby.wasm
# toolchain (rbwasm), running DIRECTLY on the host — no container. It needs a host Ruby 3.3 toolchain
# on PATH: CI provides it with ruby/setup-ruby, and build-wasm.sh installs the pinned rbwasm itself;
# locally, use your Ruby version manager. (This replaced a Docker toolchain image, which added a
# host-header-shadow workaround and couldn't reuse GitHub's build cache across runs.)
#
# This is a heavy job (downloads wasi-sdk + compiles CRuby → wasm), so in CI it is gated to run only
# when the wasm inputs (packages/asciidoc-pdf/ruby/**) change, and CI restores the ./build + ./rubies
# compile cache via actions/cache. Locally it is opt-in: `pnpm gate` skips it by default (see gate.sh)
# — run it directly (`pnpm wasm` / scripts/ci/wasm.sh) after touching the gem closure or toolchain.
set -euo pipefail

CYAN='\033[0;36m'; GREEN='\033[0;32m'; RED='\033[0;31m'; RESET='\033[0m'
step() { echo -e "${CYAN}[ci-wasm]${RESET} $*"; }
ok()   { echo -e "${GREEN}[ci-wasm]${RESET} $*"; }
die()  { echo -e "${RED}[ci-wasm]${RESET} $*" >&2; exit 1; }

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

command -v ruby &>/dev/null || die "A host Ruby 3.3 toolchain is required (CI: ruby/setup-ruby; locally: rbenv/asdf/rvm/system Ruby)."

step "Building Asciidoctor-PDF wasm engine (ruby.wasm / rbwasm, on the host) …"
bash "$ROOT/packages/asciidoc-pdf/ruby/build-wasm.sh"

OUTPUT="$ROOT/packages/asciidoc-pdf/ruby/asciidoctor-pdf.wasm"
[ -s "$OUTPUT" ] || die "Build reported success but $OUTPUT is missing or empty."
ok "wasm engine built: $OUTPUT ($(du -h "$OUTPUT" | cut -f1))."
