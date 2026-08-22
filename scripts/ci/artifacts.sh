#!/usr/bin/env bash
# Gem-derived committed artifacts — drift checks.
#
# Five committed artifacts in this repository are a MECHANICAL DERIVATION of the vendored
# Asciidoctor-PDF gem closure, and each one has a `--check` mode that re-derives it and compares:
#
#   packages/asciidoc-pdf/assets/catalogue/     check:catalogue-fonts   the gem's own typefaces, converted
#   packages/asciidoc-pdf/assets/admonitions/   check:admonition-icons  prawn-icon's admonition glyphs
#   packages/asciidoc-pdf/assets/base14/        check:base14-fonts      prawn's base-14 stand-ins + AFM metrics
#   packages/asciidoc-pdf/assets/rouge/         check:rouge-palette     rouge's taxonomy, lexers and theme styles
#   packages/shared/src/render-config/*.ts      check:theme-descriptors theme keys, seed theme, page sizes
#
# WHY THIS SCRIPT EXISTS. All five ran ONLY as `run:` lines inside the `pdf-wasm` job in
# .github/workflows/ci.yml, and nowhere else — no local gate invoked any of them at any opt-in level.
# That contradicts the convention ci.yml states about itself in several places: scripts/ci/*.sh is the
# single source of truth for what a job does, so a green local gate means a green CI job. It was
# demonstrably false here — hand-edit `packages/asciidoc-pdf/assets/rouge/palette.json`, run
# `RUN_WASM=1 RUN_DOCKER=1 pnpm gate`, and every job passed while CI's `pdf-wasm` went red. ci.yml now
# CALLS this script instead of restating the commands, so there is one list rather than two.
#
# PREREQUISITE, and why the gate probes for it rather than this script skipping on it: every check
# reads `packages/asciidoc-pdf/ruby/.wasm-build/vendor/bundle/ruby/3.3.0/gems`, which is gitignored
# build output produced by `packages/asciidoc-pdf/ruby/build-wasm.sh`. This script therefore FAILS
# when the gems are absent — a drift check that skipped its way to exit 0 is precisely the defect it
# was written to end. scripts/ci/gate.sh probes for the tree and prints a SKIPPED banner when it is
# not there, the same shape it already uses for Jobs 6 and 7; CI runs this inside `pdf-wasm`, right
# after that job built the tree, so there the prerequisite always holds.
#
# NOT gated on RUN_WASM. The checks are cheap (~6 s for all five) and none of them needs the 69 MB
# compiled engine — only the gem SOURCES beside it. Putting them behind the opt-in wasm build would
# have left the routine local gate not running them, which is the state this replaces.
#
# HOST RUBY. `check:rouge-palette` alone shells out to `ruby` (scripts/rouge-palette-dump.rb REQUIREs
# the vendored rouge and asks it for its own taxonomy rather than parsing its source, because a DSL is
# not reliably readable as text). CI has it — `ruby/setup-ruby` runs at the top of `pdf-wasm` — so in
# CI a missing Ruby is a hard failure like any other. Locally it is reported as NOT RUN and named in
# the closing summary, never folded into a pass: the same lenient-locally/strict-in-CI contract
# scripts/ci/security.sh and scripts/ci/check-migrations.sh already use, and for the same reason. A
# developer whose version manager is not on this shell's PATH must not be blocked, but must also not
# be told that a check they did not run passed. Set ARTIFACTS_STRICT=1 to require it locally.
#
# COLLATION. Every check is run TWICE: once under the caller's environment and once under a
# deliberately collation-hostile locale. The artifacts are compared as bytes, so the order anything is
# emitted in has to be a property of the data and of nothing else — and this was not hypothetical.
# `generate-theme-descriptors.mjs` sorted its keys with `localeCompare`, and under `LC_ALL=cs_CZ.UTF-8`
# (Czech collates `ch` as a single element sorting after `h`) `--check` exited 1 on an unmodified
# checkout: a drift report about the runner's language. Node ships full ICU, so the hostile locale
# takes effect without the OS having that locale generated — this works on a bare CI runner.
#
# Usage:  scripts/ci/artifacts.sh          (run by scripts/ci/gate.sh and by ci.yml's pdf-wasm job)
set -uo pipefail

CYAN='\033[0;36m'; GREEN='\033[0;32m'; YELLOW='\033[0;33m'; RED='\033[0;31m'; RESET='\033[0m'
step() { echo -e "${CYAN}[ci-artifacts]${RESET} $*"; }
ok()   { echo -e "${GREEN}[ci-artifacts]${RESET} $*"; }
warn() { echo -e "${YELLOW}[ci-artifacts]${RESET} $*"; }
fail() { echo -e "${RED}[ci-artifacts]${RESET} $*" >&2; }

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

# CI=1 implies strict: every prerequisite must be present and every check must run.
STRICT="${ARTIFACTS_STRICT:-${CI:-}}"

GEM_ROOT="$ROOT/packages/asciidoc-pdf/ruby/.wasm-build/vendor/bundle/ruby/3.3.0/gems"
if [ ! -d "$GEM_ROOT" ]; then
  fail "The vendored gems are not at $GEM_ROOT."
  fail "Nothing here can be derived without them, so there is no result to report — this is a"
  fail "failure and not a skip. Build the engine first: scripts/ci/wasm.sh (or RUN_WASM=1 pnpm gate)."
  exit 1
fi

# The second, deliberately awkward collation. See COLLATION above. `cs_CZ` is chosen because its
# multigraph rule reorders ASCII-only keys this repository actually has, so the run is a real test
# rather than a gesture at one.
HOSTILE_LOCALE='cs_CZ.UTF-8'

FAILED=0
# A check that could not RUN is tracked apart from a check that ran and disagreed. They call for
# opposite actions — fix your toolchain vs. regenerate a committed file — and the closing banner used
# to give the regenerate instruction for both, telling anyone whose Ruby was broken to rewrite an
# artifact that was never compared against anything.
BLOCKED=0
NOT_RUN=()

# run_check <label> <pnpm-filter-package> <script-name>
#
# Runs one drift check under the caller's environment and then again under the hostile collation.
# Both must pass: a committed artifact whose bytes depend on the runner's locale is drift that has not
# happened yet, and it is cheaper to fail here than on someone else's machine.
run_check() {
  local label="$1" package="$2" script="$3"
  step "$label …"
  if ! pnpm --filter "$package" "$script"; then
    fail "$label: the committed artifact does not match the vendored gems."
    FAILED=1
    return 0
  fi
  if ! LC_ALL="$HOSTILE_LOCALE" pnpm --filter "$package" "$script" > /dev/null 2>&1; then
    fail "$label: passes under this shell's locale but FAILS under LC_ALL=$HOSTILE_LOCALE."
    fail "Something in its generator orders (or formats) output through the runtime's collation —"
    fail "\`localeCompare\`, \`toLocaleString\`, an \`Intl\` default. Compare by code unit instead;"
    fail "see the comments at generate-catalogue-fonts.mjs:276 and generate-base14-fonts.mjs:927."
    FAILED=1
    return 0
  fi
  ok "$label: up to date, and byte-identical under LC_ALL=$HOSTILE_LOCALE."
}

# The committed catalogue fonts are a conversion of the gem's own typefaces, and this is the only
# context holding the gem to compare them against. Committed assets that no longer match the gem they
# claim to come from would leave the Print preview drawing a page with different metrics from the
# export's — the one thing that style promises not to do.
run_check "Catalogue fonts vs the gem" @asciidocollab/asciidoc-pdf check:catalogue-fonts

run_check "Admonition icons vs the gem" @asciidocollab/asciidoc-pdf check:admonition-icons

# The base-14 stand-ins. Their metrics are read live out of prawn's AFM files, which live in the same
# vendored gem tree, so a gem bump that moved one shows up here rather than as a preview that quietly
# sets its lines at the wrong pitch.
run_check "Base-14 stand-ins vs prawn" @asciidocollab/asciidoc-pdf check:base14-fonts

# The renderer's syntax-highlighting palette. Same reasoning as the fonts: it is read out of the
# vendored rouge and asciidoctor-pdf gems. A palette that no longer matches the gem would leave the
# preview colouring source code differently from the export while every other check stayed green.
#
# The Print stylesheet generated FROM that palette is checked in the `quality` job instead
# (scripts/ci/quality.sh): it needs neither gem nor Ruby — only the committed palette.json and the
# installed highlight.js — and the drift it catches (a hand-edit inside the generated region, or a
# highlight.js bump that changes the class vocabulary) happens on pull requests that touch no wasm
# input at all, which is exactly when this script does not run.
# A Ruby that cannot load its own stdlib is not a stale artifact. `ruby` on PATH was the whole
# precondition here, and it is not enough: the dump script opens with `require 'json'`, so an
# interpreter whose stdlib is unreachable dies before reading one byte of the gems — and run_check,
# which knows only that the command exited non-zero, announced "the committed artifact does not match
# the vendored gems". That names the repository as wrong when the machine is, and it points whoever
# reads it at regenerating a file that was correct all along.
#
# It is the in-repo toolchain's normal state, not a hypothetical: the ruby under
# packages/asciidoc-pdf/ruby/build/**/opt/bin runs, reports its version, and still cannot `require
# 'json'` until RUBYLIB names its stdlib. So probe for what the dump actually needs — the require
# itself, on the interpreter that will run it — and treat a failure as the check NOT RUNNING.
RUBY_STDLIB_PROBE_OK=0
if command -v ruby > /dev/null 2>&1 && ruby -e "require 'json'" > /dev/null 2>&1; then
  RUBY_STDLIB_PROBE_OK=1
fi

if [ "$RUBY_STDLIB_PROBE_OK" = "1" ]; then
  run_check "Rouge palette vs the gems" @asciidocollab/asciidoc-pdf check:rouge-palette
elif command -v ruby > /dev/null 2>&1; then
  # Present, runnable, and unusable — the case that used to be reported as drift.
  IN_REPO_RUBY="$ROOT/packages/asciidoc-pdf/ruby/build/x86_64-pc-linux/baseruby-3.3/opt"
  if [ -n "$STRICT" ]; then
    fail "Rouge palette vs the gems: the \`ruby\` on PATH cannot load its own stdlib (\`require 'json'\`"
    fail "fails), so the dump cannot run. This is NOT artifact drift — do not regenerate anything."
    BLOCKED=1
  else
    warn "Rouge palette vs the gems: NOT RUN — the \`ruby\` on PATH cannot \`require 'json'\`."
    warn "This is a broken toolchain, NOT drift: nothing was compared, and the committed palette may"
    warn "be perfectly current. Do not regenerate it on the strength of this message."
    NOT_RUN+=("check:rouge-palette (host Ruby cannot load its stdlib)")
  fi
  if [ -d "$IN_REPO_RUBY/lib/ruby/3.3.0" ]; then
    warn "This repo's own Ruby 3.3 needs its load path spelled out — it ships without one:"
    warn "  PATH=\"$IN_REPO_RUBY/bin:\$PATH\" \\"
    warn "  RUBYLIB=\"$IN_REPO_RUBY/lib/ruby/3.3.0:$IN_REPO_RUBY/lib/ruby/3.3.0/x86_64-linux\" \\"
    warn "  scripts/ci/artifacts.sh"
  fi
elif [ -n "$STRICT" ]; then
  fail "Rouge palette vs the gems: no \`ruby\` on PATH, and it is required in strict/CI mode."
  fail "CI puts it there with ruby/setup-ruby at the top of the pdf-wasm job."
  FAILED=1
else
  warn "Rouge palette vs the gems: NOT RUN — no \`ruby\` on PATH."
  warn "The dump REQUIREs the vendored rouge rather than parsing it, so the gems alone are not enough."
  warn "Put your Ruby 3.3 toolchain on PATH (the same one that vendored the gems) to run it, or set"
  warn "ARTIFACTS_STRICT=1 to make its absence a failure. CI always runs it."
  NOT_RUN+=("check:rouge-palette (no host Ruby)")
fi

# The theme-key catalogue, the seed theme, prawn's page-size table and the loader's deprecated
# spellings — four generated modules read out of the SAME vendored gems. Their generator is wired as a
# `prebuild … --if-available` hook, and the gem tree is gitignored, so in every context without a wasm
# build it finds nothing and no-ops: a `Gemfile.lock` bump that added theme keys would leave the editor
# underlining valid keys as unrecognised, the preview resolving a page size the renderer no longer has,
# and nothing anywhere saying so. `--check` is deliberately not `--if-available`-shaped.
run_check "Theme descriptors vs the gems" @asciidocollab/shared check:theme-descriptors

echo
if [ "$FAILED" != "0" ]; then
  fail "Committed gem-derived artifacts are out of date. Regenerate them with the command each check"
  fail "printed, and commit the result — do not hand-edit a generated file."
  exit 1
fi
if [ "$BLOCKED" != "0" ]; then
  fail "A drift check could not run (see above). Nothing was compared, so no artifact is implicated:"
  fail "fix the toolchain and re-run. Do NOT regenerate a committed file on the strength of this."
  exit 1
fi
if [ ${#NOT_RUN[@]} -gt 0 ]; then
  warn "Artifact drift checks passed, but ${#NOT_RUN[@]} did NOT RUN: ${NOT_RUN[*]}"
  warn "This is not a full pass. CI runs every one of them."
  exit 0
fi
ok "All five gem-derived artifacts match the vendored gems."
