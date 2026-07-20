#!/usr/bin/env bash
# Job — PDF reference-parity comparison suite.
#
# Compares the PDFs our in-browser pipeline produces against committed reference PDFs built by the
# canonical Asciidoctor-PDF toolchain. This is the fidelity oracle: where the two disagree, the
# reference is correct and our output is the defect.
#
# It needs NO app stack and NO database — the suite drives the wasm engine and the rendering shims
# directly — so it is deliberately separate from scripts/ci/e2e.sh and can run in parallel with it.
#
# Two host prerequisites, both hard requirements here:
#   * poppler-utils  — the comparison reads page counts, text layers and rasterized ink via pdfinfo /
#                      pdftotext / pdftoppm.
#   * the wasm engine at packages/asciidoc-pdf/ruby/asciidoctor-pdf.wasm.
#
# The suite itself self-skips when either is missing, which is right for a developer who has not built
# the engine — and wrong for CI, where a silent skip reports a green run that compared nothing. So this
# script FAILS when a prerequisite is absent rather than letting the suite skip its way to success.
set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; CYAN='\033[0;36m'; RESET='\033[0m'
step() { echo -e "${CYAN}[ci-pdf-parity]${RESET} $*"; }
ok()   { echo -e "${GREEN}[ci-pdf-parity]${RESET} $*"; }
die()  { echo -e "${RED}[ci-pdf-parity]${RESET} $*" >&2; exit 1; }

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

WASM="$ROOT/packages/asciidoc-pdf/ruby/asciidoctor-pdf.wasm"

# ─── Prerequisites ────────────────────────────────────────────────────────────
for tool in pdfinfo pdftotext pdftoppm; do
  command -v "$tool" &>/dev/null || die "$tool is required (install poppler-utils)."
done

if [[ ! -f "$WASM" ]]; then
  die "Asciidoctor-PDF wasm engine not found at $WASM. Run 'pnpm wasm' (or restore the CI artifact) first."
fi

# ─── Build ───────────────────────────────────────────────────────────────────
# The harness imports @asciidocollab/asciidoc-pdf's compiled pipeline stages, so the workspace
# packages have to be built — but the Next.js app does not.
step "Building shared packages …"
pnpm --filter '!@asciidocollab/web' -r build

# ─── Suite ───────────────────────────────────────────────────────────────────
step "Running the PDF reference-parity suite …"
pnpm --filter @asciidocollab/web pdf-parity

# ─── Extension load-order independence ───────────────────────────────────────
# The suite above cannot catch this, and the distinction is the whole reason this step exists.
#
# Extensions customise the converter by `prepend`ing a module, so two that override the same hook wrap
# each other — and which is outermost is fixed by whichever was `require`d FIRST. The wasm VM is warm
# and never torn down, so that is decided by whichever project rendered first in the worker, not by
# what this render selected. An extension whose output depends on that renders one document for the
# first project through a worker and a different one for the next.
#
# Every fixture above renders ONE order and compares it against a reference rendered the same way, so
# it agrees with itself whichever order that is. This step renders both and requires them to match.
# It caught a real divergence in theme-editing-all-extensions whose committed reference was completely
# unchanged by the fix — the forward order happened to be the correct one, so only the reversed order
# ever showed it.
#
# Docker, like every reference tool. Hard requirement for the same reason as the engine above: a skip
# here reports a green run that compared nothing.
step "Checking extension load order does not change the output …"
command -v docker &>/dev/null || die "docker is required for the extension load-order check."
node apps/web/e2e/pdf-parity/tools/check-extension-order.mjs

ok "PDF reference parity passed."
