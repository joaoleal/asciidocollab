#!/usr/bin/env bash
# Job 5 — Security scan: SAST · secrets · dependency CVEs · workflow hardening · dead code.
#
# Mirrors the `security` job in .github/workflows/ci.yml so local runs reproduce CI. The scanners
# here are NOT npm packages (Semgrep/zizmor are pip, gitleaks/OSV-Scanner are release binaries), so
# unlike the other jobs they are not auto-fetched by npx. When a tool is missing this script prints
# an install hint and SKIPS it — lenient by default so `pnpm gate` stays runnable on a fresh machine.
# Set SECURITY_STRICT=1 (CI does, via CI=1) to turn a missing tool into a hard failure, matching the
# workflow where every scanner is installed.
set -uo pipefail

CYAN='\033[0;36m'; GREEN='\033[0;32m'; YELLOW='\033[0;33m'; RED='\033[0;31m'; RESET='\033[0m'
step() { echo -e "${CYAN}[ci-security]${RESET} $*"; }
ok()   { echo -e "${GREEN}[ci-security]${RESET} $*"; }
warn() { echo -e "${YELLOW}[ci-security]${RESET} $*"; }
fail() { echo -e "${RED}[ci-security]${RESET} $*"; }

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

# CI=1 implies strict: every scanner must be present and pass.
STRICT="${SECURITY_STRICT:-${CI:-}}"

FAILED=0
SKIPPED=0

# run_scan <tool-binary> <install-hint> <command...>
run_scan() {
  local bin="$1" hint="$2"; shift 2
  if ! command -v "$bin" >/dev/null 2>&1; then
    if [ -n "$STRICT" ]; then
      fail "$bin not installed (required in strict/CI mode). Install: $hint"
      FAILED=1
    else
      warn "$bin not installed — SKIPPING. Install to run locally: $hint"
      SKIPPED=$((SKIPPED + 1))
    fi
    return 0
  fi
  if "$@"; then
    ok "$bin passed."
  else
    fail "$bin reported findings (exit $?)."
    FAILED=1
  fi
}

# Semgrep — SAST (path traversal, weak crypto, missing sanitization, …). Registry packs + the
# first-party rules in .semgrep.yml; path excludes in .semgrepignore. Identical to `pnpm semgrep`.
step "Semgrep (SAST) …"
run_scan semgrep "pipx install semgrep  (or: pip install semgrep)" \
  semgrep --config p/security-audit --config p/owasp-top-ten --config .semgrep.yml --error --quiet .

# zizmor — GitHub Actions workflow hardening (unpinned-uses policy in zizmor.yml).
step "zizmor (workflow hardening) …"
run_scan zizmor "pipx install zizmor  (or: pip install zizmor)" \
  zizmor .github/workflows/

# gitleaks — secret scan across full git history (allowlist in .gitleaks.toml).
step "gitleaks (secret scan) …"
run_scan gitleaks "https://github.com/gitleaks/gitleaks/releases (or: brew install gitleaks)" \
  gitleaks git --redact --verbose

# OSV-Scanner — dependency CVEs. Gated at High+ (CVSS >= 7.0) to match `pnpm audit --audit-level=high`.
step "OSV-Scanner (dependency CVEs, gate at High+) …"
if ! command -v osv-scanner >/dev/null 2>&1; then
  if [ -n "$STRICT" ]; then
    fail "osv-scanner not installed (required in strict/CI mode). Install: https://github.com/google/osv-scanner/releases"
    FAILED=1
  else
    warn "osv-scanner not installed — SKIPPING. Install: https://github.com/google/osv-scanner/releases"
    SKIPPED=$((SKIPPED + 1))
  fi
else
  OSV_JSON="$(mktemp)"
  # `|| true` is required — osv-scanner exits non-zero when it FINDS advisories, which is not an
  # error here; the gate below decides. But it also exits non-zero on a genuine failure (network,
  # unreadable lockfile), which leaves an empty report. Validate before drawing any conclusion: an
  # unparsable report read as "zero advisories" is a scan that never ran reporting a clean result.
  osv-scanner scan --lockfile=pnpm-lock.yaml --format=json > "$OSV_JSON" || true
  osv-scanner scan --lockfile=pnpm-lock.yaml || true   # human-readable table

  if [ ! -s "$OSV_JSON" ] || ! jq -e 'type == "object"' "$OSV_JSON" >/dev/null 2>&1; then
    rm -f "$OSV_JSON"
    fail "osv-scanner produced no parsable JSON — treating as a scan failure, not a clean result."
    FAILED=1
  else
    # `.results` is ABSENT (not empty) when nothing was scanned, so every level is indexed with `?`
    # to yield nothing rather than error. Severities are strings and some advisory groups carry a
    # CVSS vector rather than a base score, so `tonumber` is applied only to values that actually
    # look numeric — an unguarded `tonumber` aborts on the first vector string and, under `set -e`,
    # kills the whole gate with no indication of why.
    SEVERITIES='[ .results[]?.packages[]?.groups[]?.max_severity? // empty | select(. != "") ]'
    NUMERIC='test("^[0-9]+(\\.[0-9]+)?$")'

    HIGH=$(jq "$SEVERITIES | map(select($NUMERIC) | tonumber) | map(select(. >= 7.0)) | length" "$OSV_JSON")
    UNGATED=$(jq "$SEVERITIES | map(select($NUMERIC | not)) | length" "$OSV_JSON")
    rm -f "$OSV_JSON"

    echo "High+ (CVSS >= 7.0) advisories: $HIGH"
    # Reported rather than silently dropped: a non-numeric severity may well be a High. Written as a
    # full `if` rather than `[ ... ] && warn` — the latter makes the whole line exit 1 when the test
    # is false, which would abort the script the moment anyone adds `-e` to the `set` line above.
    if [ "$UNGATED" -gt 0 ]; then
      warn "$UNGATED advisory group(s) report a non-numeric max_severity and were not gated — review the table above."
    fi

    if [ "$HIGH" -eq 0 ]; then
      ok "osv-scanner passed (no High+ advisories)."
    else
      fail "osv-scanner found $HIGH High+ advisory(ies)."
      FAILED=1
    fi
  fi
fi

# knip — dead-code / unused-dependency report. NON-GATING (matches ci.yml continue-on-error): the
# dist-entry package layout + dynamic deps produce known false positives pending curation.
step "Dead-code report (knip) — non-gating …"
npx knip || warn "knip reported findings (non-gating — review manually)."

echo
if [ "$FAILED" -ne 0 ]; then
  fail "Security scan FAILED."
  exit 1
fi
if [ "$SKIPPED" -ne 0 ]; then
  warn "Security scan passed for installed tools, but $SKIPPED scanner(s) were SKIPPED."
  warn "CI enforces all of them (SECURITY_STRICT=1). Install the tools above to fully reproduce CI locally."
else
  ok "All security scans passed."
fi
