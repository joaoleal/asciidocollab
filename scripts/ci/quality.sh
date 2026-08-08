#!/usr/bin/env bash
# Job 1 — Quality gate: build, lint, type-check, architecture guard, security audit.
set -euo pipefail

CYAN='\033[0;36m'; GREEN='\033[0;32m'; RESET='\033[0m'
step() { echo -e "${CYAN}[ci-quality]${RESET} $*"; }
ok()   { echo -e "${GREEN}[ci-quality]${RESET} $*"; }

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

step "Building packages (generates declaration files) …"
pnpm -r build

step "Linting …"
npx eslint .

# Type-check through each workspace's tsconfig.eslint.json, NOT its build tsconfig.json.
#
# Every build config is `include: ["src"]` — that is what it compiles — so pointing the gate at it
# type-checked source only, and `tests/` and `apps/web/e2e/` were never checked by anything. The gap
# was not theoretical: closing it surfaced 709 errors, including stubs naming methods their port does
# not have (`sendInvitationEmail` for `sendInvitation`, `deleteAllForUser`, an event bus stubbed with
# `on`/`off` when it is `emit`/`subscribe`), a `new User(...)` whose 8th argument landed in the
# `isAdmin` slot, an `ApiError(code, message)` double against a 4-argument constructor, and a props
# fixture still passing a prop renamed several features ago. Each one type-checks as a passing test
# that exercises something the production code never does.
#
# tsconfig.eslint.json is the same compiler options over `src` + `tests` (+ `e2e` for web) and is
# already the project ESLint parses with, so there is one description of the tree rather than two.
step "Type-checking db …"
npx tsc -p packages/db/tsconfig.json --noEmit

# The shared test-helper package every suite builds on. It has no tests/ of its own, so its build
# config IS its full surface — but it was absent from this list entirely, which left the one package
# best placed to hide a bad fixture as the only one nothing checked.
step "Type-checking testing …"
npx tsc -p packages/testing/tsconfig.json --noEmit

step "Type-checking shared (src + tests) …"
npx tsc -p packages/shared/tsconfig.eslint.json --noEmit

step "Type-checking asciidoc-core (src + tests) …"
npx tsc -p packages/asciidoc-core/tsconfig.eslint.json --noEmit

step "Type-checking asciidoc-pdf (src + tests) …"
npx tsc -p packages/asciidoc-pdf/tsconfig.eslint.json --noEmit

step "Type-checking domain (src + tests) …"
npx tsc -p packages/domain/tsconfig.eslint.json --noEmit

step "Type-checking infrastructure (src + tests) …"
npx tsc -p packages/infrastructure/tsconfig.eslint.json --noEmit

step "Type-checking API (src + tests) …"
npx tsc -p apps/api/tsconfig.eslint.json --noEmit

step "Type-checking collab (src + tests) …"
npx tsc -p apps/collab/tsconfig.eslint.json --noEmit

# Web needs BOTH projects, because neither covers the other. tsconfig.eslint.json adds tests/ and
# e2e/; tsconfig.json adds what Next GENERATES into .next/types (the route table and the page-prop
# `validator.ts`, present because `pnpm -r build` ran above) plus the root-level configs. Running only
# the first would widen coverage in one direction while quietly dropping it in the other — and the
# generated validator is exactly where a page whose props no longer match its route shows up.
step "Type-checking web (src + generated route types) …"
npx tsc -p apps/web/tsconfig.json --noEmit

step "Type-checking web (src + tests + e2e) …"
npx tsc -p apps/web/tsconfig.eslint.json --noEmit

step "Architecture guard (layer boundaries) …"
# Enforces onion.config.json. This replaced `fresh-onion`, which could not check anything here: it
# skipped every import specifier that does not begin with `.` or `/`, and this monorepo crosses layers
# exclusively by workspace name (`@asciidocollab/domain`) — a scan found ZERO relative cross-package
# imports. It also located its config by DESCENDING from the cwd and taking the first readdir hit, so a
# leftover config inside an agent worktree could win and get a stale tree validated instead, and did.
# Both faults were structural, so the check is now ours: it resolves bare specifiers through each
# package's declared name, still checks relative ones, and derives the config path from its own
# location. See the header of the script for the full account.
node "$ROOT/scripts/ci/architecture-guard.mjs"

step "Security audit (high+ severity) …"
# `pnpm audit` calls the npm advisories endpoint, which is outside this repo's control. It has been
# observed returning HTTP 200 with a gzip-compressed body and NO `Content-Encoding` header, so every
# header-respecting client — pnpm included — fails to parse it (ERR_PNPM_AUDIT_BAD_RESPONSE). A defect
# in someone else's CDN is not a security finding about this repository, and failing the gate on it
# reports nothing actionable while blocking every build.
#
# So separate the two outcomes. A real advisory result still fails the gate, unchanged. A transport or
# parse failure warns loudly and defers to Job 4's OSV-Scanner, which gates dependency CVEs at the SAME
# High+ threshold over the same pnpm-lock.yaml from an independent source (osv.dev) — so the signal is
# not lost, only its second opinion. Never broaden this to swallow a non-empty advisory list.
AUDIT_OUT="$(pnpm audit --audit-level=high 2>&1)" && AUDIT_OK=1 || AUDIT_OK=0
if [ "$AUDIT_OK" = "1" ]; then
  echo "$AUDIT_OUT" | tail -3
else
  case "$AUDIT_OUT" in
    *ERR_PNPM_AUDIT_BAD_RESPONSE*|*ERR_PNPM_AUDIT_ENDPOINT*|*ENOTFOUND*|*ETIMEDOUT*|*ECONNRESET*|*ECONNREFUSED*|*EAI_AGAIN*)
      # Truncate: the unparseable body is binary and floods the log.
      echo "$AUDIT_OUT" | head -c 400
      echo ""
      echo "[ci-quality] WARNING: the npm advisories endpoint is unusable (transport/parse failure, not a finding)."
      echo "[ci-quality] Dependency CVEs remain gated at High+ by OSV-Scanner in Job 4 (scripts/ci/security.sh)."
      ;;
    *)
      echo "$AUDIT_OUT"
      exit 1
      ;;
  esac
fi

# Development applies the schema with `db push`; production runs `migrate deploy`.
# This catches a schema change that never got a migration — which would pass every
# other gate and then simply not reach production. Needs a database, so it skips
# locally when none is reachable and is strict under CI.
step "Prisma migration drift (schema.prisma vs prisma/migrations) …"
"$(dirname "${BASH_SOURCE[0]}")/check-migrations.sh"

# Dead-code / unused-dependency report. NON-GATING (matches ci.yml): the dist-entry package layout +
# dynamic deps produce known false positives pending curation, so knip's findings never fail the gate.
step "Dead-code report (knip) — non-gating …"
# `::notice::` surfaces findings as a CI annotation (a no-op string locally); `|| echo` keeps knip's
# normal non-empty exit from failing the gate.
npx knip || echo "::notice::knip reported findings (non-gating — see log for details)"

ok "All quality checks passed."
