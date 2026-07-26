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

step "Type-checking shared …"
npx tsc -p packages/shared/tsconfig.json --noEmit

step "Type-checking domain …"
npx tsc -p packages/domain/tsconfig.json --noEmit

step "Type-checking infrastructure …"
npx tsc -p packages/infrastructure/tsconfig.json --noEmit

step "Type-checking API …"
npx tsc -p apps/api/tsconfig.json --noEmit

step "Type-checking collab …"
npx tsc -p apps/collab/tsconfig.json --noEmit

step "Type-checking web …"
npx tsc -p apps/web/tsconfig.json --noEmit

step "Architecture guard (fresh-onion) …"
# fresh-onion finds onion.config.json by DESCENDING from the cwd, taking the first hit in readdir
# order, and then treating that file's own directory as the tree to check. So any nested copy can win
# — and one did: `.claude/worktrees/<agent>/onion.config.json`, left behind by an agent worktree, was
# picked ahead of the root config. The guard then validated that stale worktree's sources against an
# outdated config with no asciidoc-pdf layer at all, and still printed "Fresh". Worse, readdir order
# is not stable, so which tree got checked varied between machines and runs.
#
# The tool has no --config flag, so stage the check instead: a scratch directory holding the real
# config plus SYMLINKS to apps/ and packages/. readdir reports a symlink as not-a-directory, so the
# search cannot descend past the config — resolution becomes deterministic — while the layer paths
# still resolve through the links to the real sources. Import paths stay self-consistent because the
# tool compares them with plain path arithmetic and never calls realpath.
ONION_STAGE="$(mktemp -d)"
cleanup_onion() { rm -rf "$ONION_STAGE"; }
trap cleanup_onion EXIT
cp "$ROOT/onion.config.json" "$ONION_STAGE/onion.config.json"
ln -s "$ROOT/apps" "$ONION_STAGE/apps"
ln -s "$ROOT/packages" "$ONION_STAGE/packages"
ONION_BIN="$(node -p "require.resolve('fresh-onion/dist/src/index.js', { paths: ['$ROOT'] })")"
ONION_OUT="$(cd "$ONION_STAGE" && node "$ONION_BIN")" || { echo "$ONION_OUT"; exit 1; }
echo "$ONION_OUT"
# Belt and braces: fail loudly if a future change lets it wander off the staged config again, rather
# than passing on whatever tree it happened to find.
case "$ONION_OUT" in
  *"Using config $ONION_STAGE/onion.config.json"*) ;;
  *) echo "Architecture guard read the wrong config — refusing to trust this result." >&2; exit 1 ;;
esac
cleanup_onion
trap - EXIT

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
