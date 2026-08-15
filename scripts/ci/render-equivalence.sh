#!/usr/bin/env bash
# Job — Render-equivalence suite (the WEB-format preview's gates).
#
# Four gates over apps/web/src/workers/asciidoc-render.worker.ts, none of which the PDF-parity suite
# can stand in for — that one drives a different engine entirely (see
# apps/web/e2e/render-equivalence/README.md):
#
#   web-format-reference.spec.ts     in-app render vs a pinned external Asciidoctor toolchain, built
#                                    as a Docker image. The only fidelity oracle the web format has.
#   web-format-equivalence.spec.ts   in-app render vs output captured before the engine was changed.
#   cross-format-agreement.spec.ts   web-format render vs page-format (PDF) render of the same source.
#   capture-previous-engine.spec.ts  the capture tool. Self-skips unless CAPTURE_PREVIOUS_ENGINE=1;
#                                    that skip is correct and is the only expected one.
#
# Like the PDF-parity suite it needs NO app stack, NO database and NO auth: the specs drive the render
# worker directly in Node. That is why it has its own Playwright config
# (apps/web/playwright.render-equivalence.config.ts) declaring what it actually needs — a 240 s
# per-test budget and `workers: 1` — rather than running under the app-stack config's 45 s / 3 workers.
#
# Until this script existed, NOTHING invoked that config. The specs ran instead as part of the main
# e2e job's `chromium` project, whose `testIgnore` named pdf-parity's specs file by file and so never
# excluded this directory: 34 tests against a live stack they do not use, at a timeout under which the
# reference gate's `beforeAll` Docker image build cannot complete on a cold cache. They now run here.
#
# Two host prerequisites, both HARD requirements — the specs self-skip without them, which is right
# for a developer and wrong for a gate, where a silent skip is a green run that compared nothing:
#   * docker      — the canonical reference toolchain is a Docker image tagged by a hash of its
#                   definition files.
#   * the wasm engine at packages/asciidoc-pdf/ruby/asciidoctor-pdf.wasm, for the cross-format gate.
set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; CYAN='\033[0;36m'; RESET='\033[0m'
step() { echo -e "${CYAN}[ci-render-equivalence]${RESET} $*"; }
ok()   { echo -e "${GREEN}[ci-render-equivalence]${RESET} $*"; }
die()  { echo -e "${RED}[ci-render-equivalence]${RESET} $*" >&2; exit 1; }

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

WASM="$ROOT/packages/asciidoc-pdf/ruby/asciidoctor-pdf.wasm"

# ─── Prerequisites ────────────────────────────────────────────────────────────
command -v docker &>/dev/null \
  || die "docker is required — the canonical reference build runs the pinned toolchain in a container."
docker version --format '{{.Server.Version}}' &>/dev/null \
  || die "the docker daemon is not reachable; the canonical reference build cannot run."

[[ -f "$WASM" ]] \
  || die "Asciidoctor-PDF wasm engine not found at $WASM. Run 'pnpm wasm' (or restore the CI artifact) first — the cross-format gate needs it."

# ─── Build ───────────────────────────────────────────────────────────────────
# The harness imports the workspace packages' compiled output (including the page-format pipeline the
# cross-format gate renders through), but not the Next.js app.
step "Building shared packages …"
pnpm --filter '!@asciidocollab/web' -r build

# Same reason as scripts/ci/pdf-parity.sh: the page-format render decodes .woff2 through the vendored
# codec at apps/web/public/vendor/woff2/woff2.wasm, a gitignored artifact normally produced by the web
# `prebuild` hook — which is skipped above because the app is not built here. Cheap and self-contained.
step "Building the WOFF2 codec …"
pnpm --filter @asciidocollab/web run build:woff2-wasm

# ─── Suite ───────────────────────────────────────────────────────────────────
step "Running the render-equivalence suite …"
pnpm --filter @asciidocollab/web render-equivalence

ok "Render equivalence passed."
