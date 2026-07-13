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

step "Shared unit tests with coverage …"
(cd packages/shared && npx jest --coverage --coverageReporters=text lcov)

step "Domain unit tests with coverage …"
(cd packages/domain && npx jest --coverage --coverageReporters=text lcov)

step "API unit tests with coverage …"
(cd apps/api && npx jest --coverage --coverageReporters=text lcov)

# The collab suite runs under ESM, so it needs --experimental-vm-modules (its own `test` script sets
# it); pass it here too since we invoke jest directly for coverage.
step "Collaboration server unit tests with coverage …"
(cd apps/collab && NODE_OPTIONS=--experimental-vm-modules npx jest --coverage --coverageReporters=text lcov)

step "Web unit tests with coverage …"
pnpm --filter @asciidocollab/web test:ci

ok "All unit tests passed."
