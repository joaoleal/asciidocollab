#!/usr/bin/env bash
# Job 3 — Infrastructure integration tests. Testcontainers manages its own PostgreSQL
# container; no external database required.
set -euo pipefail

CYAN='\033[0;36m'; GREEN='\033[0;32m'; RESET='\033[0m'
step() { echo -e "${CYAN}[ci-integration]${RESET} $*"; }
ok()   { echo -e "${GREEN}[ci-integration]${RESET} $*"; }

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

step "Building packages …"
pnpm -r build

step "Infrastructure integration tests …"
# jest.config.cjs deliberately does NOT set `passWithNoTests`: this package has tests, so a run that
# matches none of them is a broken invocation (bad filter, renamed directory, a stray argument
# reaching jest as a test-path pattern), not a clean result. Without that, jest prints "No tests
# found, exiting with code 0" and this gate goes green having tested nothing — which is exactly how
# it once passed. Never add the flag back here or there.
#
# Run WITH --coverage. Without it, the 90% `coverageThreshold` in that package's jest.config.cjs is
# dead configuration: this is the only job that runs the package at all, and it ran plain `jest`, so
# the threshold was checked by nothing. (The unit job — scripts/ci/unit.sh — covers every OTHER
# package but not this one.) Paired with the `collectCoverageFrom` added to that config, the number
# is now measured over the whole of src and actually enforced.
TESTCONTAINERS_RYUK_DISABLED=true pnpm --filter @asciidocollab/infrastructure exec jest --coverage --coverageReporters=text --coverageReporters=lcov

ok "All integration tests passed."
