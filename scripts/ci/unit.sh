#!/usr/bin/env bash
# Job 2 — Unit tests with coverage. No external services required.
set -euo pipefail

CYAN='\033[0;36m'; GREEN='\033[0;32m'; RESET='\033[0m'
step() { echo -e "${CYAN}[ci-unit]${RESET} $*"; }
ok()   { echo -e "${GREEN}[ci-unit]${RESET} $*"; }

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

step "Building packages (generates Prisma client + declaration files) …"
pnpm -r build

# Run coverage for EVERY package, matching the CI unit job exactly (it enforces the 90% global
# threshold per package). Running fewer here — or without coverage — lets a per-package coverage
# regression pass locally and only fail in CI, which is what previously slipped through.

step "Asciidoc-core unit tests with coverage …"
(cd packages/asciidoc-core && npx jest --coverage --coverageReporters=text lcov)

step "Primitives unit tests with coverage …"
(cd packages/primitives && npx jest --coverage --coverageReporters=text lcov)

# packages/shared/tests/print-appearance holds wall-clock performance budgets whose millisecond
# assertions flake under istanbul instrumentation (coverage inflates measured time by 5-20%) and
# under jest's parallel workers (which oversubscribe CPU). Rather than loosen the budgets to survive
# either, the shared step runs TWO passes:
#   1. Coverage pass, budgets OFF (ASCIIDOCOLLAB_PERF_BUDGETS=off) — the tests still run, so this
#      remains the only coverage for print-appearance internals and the functions elsewhere only
#      these tests exercise, but the timing assertions are skipped since instrumentation overhead
#      is not "the code under test". Parallel is fine here; nothing timing-sensitive is asserted.
#   2. Performance pass, budgets ON (the default), NO coverage — un-instrumented, and with EACH
#      suite file in its own fresh jest process. A single --runInBand process accumulates heap across
#      all ~1400 print-appearance tests, and the heaviest cases (largest-document resolve/parse) then
#      blow their millisecond budgets from GC pressure rather than from the code — highly variable
#      run to run. A fresh process per file keeps the heap clean and the timings representative, with
#      no cross-file parallelism to oversubscribe CPU.
step "Shared unit tests with coverage …"
(cd packages/shared && ASCIIDOCOLLAB_PERF_BUDGETS=off npx jest --coverage --coverageReporters=text lcov)

step "Shared performance budgets (un-instrumented, per-file isolation) …"
(
  cd packages/shared
  for perf_spec in tests/print-appearance/*.test.ts; do
    npx jest --runInBand "$perf_spec"
  done
)

step "Domain unit tests with coverage …"
(cd packages/domain && npx jest --coverage --coverageReporters=text lcov)

step "Asciidoc-pdf unit tests with coverage …"
pnpm --filter @asciidocollab/asciidoc-pdf test:ci

# @fastify/cookie 11.1.2 reaches the (ESM-only) `cookie` package through a dynamic import, which jest's
# CJS runtime rejects without --experimental-vm-modules. The package's own `test` script sets it; pass it
# here too since we invoke jest directly for coverage.
# --runInBand: this suite includes a wall-clock performance budget (failed-sign-in purge); see the
# shared step above for why performance tests must run isolated on a single worker.
step "API unit tests with coverage …"
(cd apps/api && NODE_OPTIONS=--experimental-vm-modules npx jest --coverage --coverageReporters=text lcov --runInBand)

# The collab suite runs under ESM, so it needs --experimental-vm-modules (its own `test` script sets
# it); pass it here too since we invoke jest directly for coverage.
# --runInBand: this suite includes a wall-clock storage-probe timing; see the shared step above for
# why performance tests must run isolated on a single worker.
step "Collaboration server unit tests with coverage …"
(cd apps/collab && NODE_OPTIONS=--experimental-vm-modules npx jest --coverage --coverageReporters=text lcov --runInBand)

# git-worker also runs under ESM (same reason as collab, above).
step "Git-worker unit tests with coverage …"
(cd apps/git-worker && NODE_OPTIONS=--experimental-vm-modules npx jest --coverage --coverageReporters=text lcov)

# --runInBand: this suite includes wall-clock performance budgets (print-preview font metrics, render
# worker timings); see the shared step above for why performance tests must run isolated on a single
# worker. This is the same command as the package's own `test:ci` (jest --coverage) with the added
# isolation flag — invoked directly here because pnpm does not forward the flag cleanly through the script.
step "Web unit tests with coverage …"
(cd apps/web && npx jest --coverage --coverageReporters=text lcov --runInBand)

ok "All unit tests passed."
