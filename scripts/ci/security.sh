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
# .semgrepignore uses GITIGNORE semantics, where an unanchored directory pattern matches a directory
# of that name at any depth. `scripts/` was written for the repo-root shell wrappers and had quietly
# grown to cover apps/web/scripts/, packages/asciidoc-pdf/scripts/ and packages/shared/scripts/ — the
# first-party generator JavaScript, ~6,150 lines of it, unscanned. It is anchored now (`/scripts/`),
# and 45 files under those directories entered the scan as a result.
#
# Checked here because the failure is invisible in semgrep's output: a scan that skips a tree reports
# nothing about it and exits 0, which reads exactly like clean code.
step "Semgrep exclude anchoring (.semgrepignore) …"
if grep -qE '^[[:space:]]*scripts/?[[:space:]]*$' "$ROOT/.semgrepignore"; then
  fail ".semgrepignore excludes a bare \`scripts\` directory pattern."
  fail "Gitignore semantics make that match EVERY directory named scripts at any depth, so the"
  fail "generator JavaScript under apps/web/scripts/ and packages/*/scripts/ leaves the SAST scan"
  fail "without a word. Anchor it to the root wrappers it was written for: /scripts/**/*.sh"
  FAILED=1
else
  ok "The scripts exclusion is anchored; per-package generator code stays in the scan."
fi

step "Semgrep (SAST) …"
run_scan semgrep "pipx install semgrep  (or: pip install semgrep)" \
  semgrep --config p/security-audit --config p/owasp-top-ten --config .semgrep.yml --error --quiet .

# zizmor — GitHub Actions workflow hardening (unpinned-uses policy in zizmor.yml).
step "zizmor (workflow hardening) …"
run_scan zizmor "pipx install zizmor  (or: pip install zizmor)" \
  zizmor .github/workflows/

# The allowlist's SHAPE, checked before the scan that trusts it.
#
# A gitleaks v8 allowlist combines its conditions with OR unless `condition = "AND"` is declared. So a
# `paths` list does not narrow a `regexes` list — it stands beside it, and every finding whose path
# matches is dropped whatever it contains. .gitleaks.toml carried both, which exempted every
# `*.test.ts`, every `tests/`/`test/` directory at any depth, every `*.sh` under any directory named
# `scripts`, and `.github/workflows/ci.yml` from secret scanning outright.
#
# Measured on gitleaks 8.30.1: one randomly generated AWS key written byte-identically into eleven
# paths in a scratch repository was reported eleven times with no config and five times with that
# one — path alone decided, and the six suppressed files matched none of its regexes.
#
# This runs ahead of the scan because a scan cannot report what its own config told it to ignore: the
# failure is invisible in gitleaks' output by construction. Grepping the TOML rather than parsing it
# keeps the check dependency-free; both spellings that would restore the hole are caught.
step "gitleaks allowlist shape (no path-only exemptions) …"
if grep -qE '^[[:space:]]*paths[[:space:]]*=' "$ROOT/.gitleaks.toml" \
   && ! grep -qE '^[[:space:]]*condition[[:space:]]*=[[:space:]]*"AND"' "$ROOT/.gitleaks.toml"; then
  fail ".gitleaks.toml declares \`paths\` in an allowlist without \`condition = \"AND\"\`."
  fail "Gitleaks v8 ORs allowlist conditions, so that exempts whole directories from secret scanning"
  fail "regardless of content — a real key committed to any matching path is never reported."
  fail "Allowlist the VALUE instead (the \`regexes\` list), or set condition = \"AND\"."
  FAILED=1
else
  ok "gitleaks allowlist exempts by content, not by path."
fi

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
  OSV_TABLE="$(mktemp)"
  osv-scanner scan --lockfile=pnpm-lock.yaml > "$OSV_TABLE" 2>&1 || true   # human-readable table
  cat "$OSV_TABLE"

  # ─── Positive control for the phrase the next check greps for ──────────────────────────────────
  # That check is a grep for presentation text in someone else's tool, and the CI install step
  # resolves `gh release view … latest`, so the scanner doing the scanning changes without notice.
  # Reword "has unused ignores:" upstream and the grep matches nothing — at which point a blind gate
  # and a clean tree produce byte-identical output. Nothing downstream can tell them apart, which is
  # the failure mode of every check whose only evidence is the absence of a string.
  #
  # So ask the installed binary to say it, on a tree whose answer is known: one throwaway lockfile
  # with a single package, one config carrying a deliberately unmatchable advisory id. That MUST
  # report an unused ignore. It runs `--offline` against a six-line lockfile — ~30 ms, no network,
  # no bearing on this repo's real scan — and if the phrase does not come back, the vocabulary moved
  # and the real check below is verifying nothing, so the job fails instead of passing quietly.
  OSV_PROBE="$(mktemp -d)"
  printf '[[IgnoredVulns]]\nid = "GHSA-0000-0000-0000"\nreason = "positive control — never matches"\n' \
    > "$OSV_PROBE/osv-scanner.toml"
  cat > "$OSV_PROBE/pnpm-lock.yaml" <<'PROBE_LOCK'
lockfileVersion: '9.0'
importers:
  .:
    dependencies:
      is-number:
        specifier: 7.0.0
        version: 7.0.0
packages:
  is-number@7.0.0:
    resolution: {integrity: sha512-41Cifkg6e8TylSpdtTpeLVMqvSBEVzTttHvERD741+pnZ8ANv0004MRL43QKPDlK9cGvNp6NZWZUBlbGXYxxng==}
snapshots:
  is-number@7.0.0: {}
PROBE_LOCK
  # `|| true`: offline, the vulnerability DB cannot load and the scanner exits non-zero. Irrelevant
  # here — the config report is emitted regardless, and it is the only thing being asserted.
  OSV_PROBE_OUT="$(osv-scanner scan --config="$OSV_PROBE/osv-scanner.toml" \
    --lockfile="$OSV_PROBE/pnpm-lock.yaml" --offline 2>&1 || true)"
  rm -rf "$OSV_PROBE"
  if printf '%s' "$OSV_PROBE_OUT" | grep -q "unused ignores"; then
    ok "osv-scanner still reports unused ignores (positive control)."
  else
    fail "osv-scanner did NOT report a deliberately unmatchable suppression as an unused ignore."
    fail "The next check greps its output for \"unused ignores\"; that phrase no longer appears, so"
    fail "the check cannot detect a stale entry in osv-scanner.toml and would pass a tree carrying one."
    fail "Re-read the scanner's output vocabulary ($(osv-scanner --version 2>&1 | head -1)) and update"
    fail "BOTH this script and the OSV-Scanner step in .github/workflows/ci.yml. Probe output:"
    printf '%s\n' "$OSV_PROBE_OUT" >&2
    FAILED=1
  fi

  # A suppression that has outlived its cause is a rule nobody reads which will one day match a real
  # advisory. osv-scanner already names the ones that matched nothing ("has unused ignores:"); until
  # now that line scrolled past in a green log. GHSA-mh99-v99m-4gvg sat in osv-scanner.toml being
  # reported as unused for as long as anyone had looked. Gate on it: pruning the entry is the fix.
  # This can only ever ADD failures — an unused ignore is never the correct steady state.
  if grep -q "unused ignores" "$OSV_TABLE"; then
    fail "osv-scanner.toml carries suppression(s) that match nothing — remove them (listed above)."
    grep -A5 "unused ignores" "$OSV_TABLE" >&2 || true
    FAILED=1
  fi
  rm -f "$OSV_TABLE"

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
    # Counted and printed, NOT gated. The threshold stays at High+ to match `pnpm audit
    # --audit-level=high`, but a Medium is not nothing: qs 6.15.1 (GHSA-q8mj-m7cp-5q26, CVSS 6.3)
    # sat in this lockfile with a one-patch fix available, and every run was green with the finding
    # printed in a table nobody read. Naming the count in the summary line is what makes it land.
    MEDIUM=$(jq "$SEVERITIES | map(select($NUMERIC) | tonumber) | map(select(. >= 4.0 and . < 7.0)) | length" "$OSV_JSON")
    UNGATED=$(jq "$SEVERITIES | map(select($NUMERIC | not)) | length" "$OSV_JSON")
    rm -f "$OSV_JSON"

    echo "High+ (CVSS >= 7.0) advisories: $HIGH"
    if [ "$MEDIUM" -gt 0 ]; then
      warn "$MEDIUM Medium (4.0 <= CVSS < 7.0) advisory group(s) — not gated, but check the table"
      warn "above for a FIXED VERSION column that is populated: a Medium with a fix is a bump, not a"
      warn "finding to live with."
    fi
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
