#!/usr/bin/env bash
# Job 1 — Quality gate: build, lint, type-check, architecture guard, security audit.
set -euo pipefail

CYAN='\033[0;36m'; GREEN='\033[0;32m'; RESET='\033[0m'
step() { echo -e "${CYAN}[ci-quality]${RESET} $*"; }
ok()   { echo -e "${GREEN}[ci-quality]${RESET} $*"; }

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

# AHEAD OF THE BUILD, and that position is the whole point of these two steps rather than a
# preference about ordering.
#
# apps/web commits two generated files — src/styles/asciidoctor-style.generated.css (the vendored
# Asciidoctor stylesheet, re-scoped) and src/lib/html-export/export-css.generated.ts (the stylesheet
# payloads an HTML export inlines). Their generators ran only as `prebuild`/`predev` hooks, which
# OVERWRITE the committed file instead of comparing against it, so nothing anywhere confirmed that
# either file's committed bytes came from its sources: a hand edit inside the generated region, or a
# re-vendored stylesheet nobody regenerated from, survived every build and every CI job. Their two
# siblings (`check:print-highlight-css`, `check:hljs-language-map`, further down) are wired in
# precisely because they are NOT in `prebuild`.
#
# So these run BEFORE `pnpm -r build`. Run after it, the web `prebuild` hook would already have
# rewritten both files from the same sources, and the check would be comparing the generator against
# itself — green by construction, whatever was committed. Do not move them below the build.
step "Committed web stylesheet artefacts vs their sources …"
pnpm --filter @asciidocollab/web check:asciidoctor-style
pnpm --filter @asciidocollab/web check:html-export-css

# MUST stay ahead of every type-check below (only the two artefact checks above may precede it, and
# they compile nothing). This is not "build early to fail fast" — the
# ordering is what makes the type-checks mean anything, and reordering it silently blinds them.
#
# Each package resolves its workspace dependencies through their package.json `types`, i.e. through
# their BUILD OUTPUT: `tsc --noEmit -p packages/shared/tsconfig.json --listFiles` reads
# packages/primitives/dist/*.d.ts, never packages/primitives/src. And `tsc -p` — unlike `tsc -b` —
# does not build a referenced project, so `--noEmit` type-checks a package against whatever snapshot
# of its dependency happens to be on disk. Declaring `references` does not save you: they are not
# inherited through `extends`, so packages/shared/tsconfig.eslint.json has none at all (check with
# `tsc --showConfig`), and even tsconfig.json's own reference is inert without `-b`.
#
# So a signature change in one workspace package and an un-updated caller in another is INVISIBLE to
# every `--noEmit` step here until the dependency is rebuilt. Demonstrated on this tree: giving
# `isPreviewStyleValue` a second required parameter in packages/primitives/src left
# `tsc --noEmit -p packages/shared/tsconfig.json` AND `-p tsconfig.eslint.json` both exiting 0, while
# `pnpm build` — which regenerates primitives' dist first, topologically — failed with
# `TS2554: Expected 2 arguments, but got 1`. That is the whole disagreement between the two, and it
# is why `pnpm typecheck` alone is not a substitute for this script.
#
# `pnpm -r build` is topological and emits, so after it every dist/*.d.ts states the truth and the
# `--noEmit` steps below are checking against current types rather than a stale snapshot. Keep it here.
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

step "Type-checking primitives (src + tests) …"
npx tsc -p packages/primitives/tsconfig.eslint.json --noEmit

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

step "Type-checking git-worker (src + tests) …"
npx tsc -p apps/git-worker/tsconfig.eslint.json --noEmit

# Web needs BOTH projects, because neither covers the other. tsconfig.eslint.json adds tests/ and
# e2e/; tsconfig.json adds what Next GENERATES into .next/types (the route table and the page-prop
# `validator.ts`, present because `pnpm -r build` ran above) plus the root-level configs. Running only
# the first would widen coverage in one direction while quietly dropping it in the other — and the
# generated validator is exactly where a page whose props no longer match its route shows up.
step "Type-checking web (src + generated route types) …"
npx tsc -p apps/web/tsconfig.json --noEmit

step "Type-checking web (src + tests + e2e) …"
# Checked by COUNTING the files this step actually opened, not by trusting the config to still say
# what it says today. apps/web/tsconfig.json `exclude`s both `e2e` and `tests` — correctly, since it
# is what `next build` compiles and Playwright specs are not part of the app — which leaves
# tsconfig.eslint.json as the ONLY thing in the repository that type-checks either directory. A
# one-word edit to its `include` would hand back exactly the hole that was found here before, where
# every tsconfig was `include: ["src"]` and 709 errors were sitting in test and e2e code that nothing
# compiled. That hole was invisible precisely because a config which checks less still exits 0.
#
# So the assertion is on observed behaviour: `--listFiles` reports every file in the program, and the
# step fails if either directory stopped contributing its test files. Same invocation, no second compile.
#
# Counted by SHAPE (`*.spec.ts` under e2e/, `*.test.ts[x]` under tests/), not "any path containing
# /apps/web/e2e/", because `--listFiles` reports the whole PROGRAM — including files pulled in
# transitively from outside `include`. apps/web/tests/helpers/test-user.test.ts imports
# `../../e2e/helpers/test-user`, and three more tests reach into e2e/pdf-parity fixtures. Under the
# old any-path count, deleting "e2e" from the include left WEB_E2E=2 (helpers/test-user.ts and the
# helpers/mailpit.ts it pulls in): the guard printed "covered 2 file(s)" and exited 0 while all 129
# Playwright spec files went untypechecked — the precise regression it advertises catching. Those two
# helpers are not specs, so a shape-matched count of them is 0 and the guard fires. Verified both
# ways on this tree.
#
# And a FLOOR rather than `> 0`, because "at least one" is not the property being asserted. `include`
# narrowed to a subdirectory, or a glob that matches one spec, would satisfy a zero-check while
# dropping nearly everything. The floors sit well under the current counts (129 e2e specs, 384 test
# files) so ordinary churn never trips them, and far above what any partial coverage would produce.
MIN_WEB_E2E_SPECS=100
MIN_WEB_TEST_FILES=300
#
# `--listFiles` writes the file list to STDOUT, where tsc also writes its diagnostics, so the run is
# captured rather than streamed — and on failure the diagnostics are dug back out and printed. Losing
# a type error into a temp file would be a far worse outcome than the hole this check guards.
WEB_FILES="$(mktemp)"
if ! npx tsc -p apps/web/tsconfig.eslint.json --noEmit --listFiles > "$WEB_FILES"; then
  grep -E 'error TS[0-9]+' "$WEB_FILES" >&2 || cat "$WEB_FILES" >&2
  rm -f "$WEB_FILES"
  exit 1
fi
WEB_E2E=$(grep -cE '/apps/web/e2e/.*\.spec\.ts$' "$WEB_FILES" || true)
WEB_TESTS=$(grep -cE '/apps/web/tests/.*\.test\.tsx?$' "$WEB_FILES" || true)
rm -f "$WEB_FILES"
echo "[ci-quality] web type-check covered $WEB_E2E spec file(s) under e2e/ (floor $MIN_WEB_E2E_SPECS)" \
     "and $WEB_TESTS test file(s) under tests/ (floor $MIN_WEB_TEST_FILES)."
if [ "$WEB_E2E" -lt "$MIN_WEB_E2E_SPECS" ] || [ "$WEB_TESTS" -lt "$MIN_WEB_TEST_FILES" ]; then
  echo "[ci-quality] ERROR: apps/web/tsconfig.eslint.json type-checked far fewer test files than expected" >&2
  echo "[ci-quality] (e2e specs: $WEB_E2E, floor $MIN_WEB_E2E_SPECS; tests: $WEB_TESTS, floor $MIN_WEB_TEST_FILES)." >&2
  echo "[ci-quality] apps/web/tsconfig.json excludes both directories, so this config is the only coverage" >&2
  echo "[ci-quality] they have. Restore \"tests\" and \"e2e\" to its \"include\" — do not delete this check." >&2
  echo "[ci-quality] If files were legitimately removed in bulk, lower the floor deliberately and say why." >&2
  exit 1
fi

# The Print preview's syntax-highlighting rules are GENERATED into apps/web/src/styles/print-preview.css
# from the renderer's own committed palette (packages/asciidoc-pdf/assets/rouge/palette.json) and the
# installed highlight.js. Neither the gem nor the wasm engine is involved, so this belongs in the gate
# every change runs rather than in the wasm job, which is skipped on the pull requests that actually
# cause the drift: a hand-edit inside the generated region, or a highlight.js bump that changes the
# class vocabulary. It lived there until it was noticed that it therefore almost never ran.
step "Print style highlighting rules vs the renderer's palette …"
pnpm --filter @asciidocollab/web check:print-highlight-css

# The render worker fetches a syntax grammar for any language `highlight.js/lib/common` does not
# already carry, through a GENERATED name → import map (apps/web/src/workers/hljs-languages.generated.ts).
# The map is what keeps an author-supplied language name out of an `import()` specifier, and it is
# derived from the installed package, so a highlight.js bump that adds, removes or renames a grammar —
# or moves one in or out of `lib/common` — has to fail here rather than quietly change which languages
# the preview can colour. Same reasoning, and the same derivation, as the check above.
step "On-demand grammar map vs the installed highlight.js …"
pnpm --filter @asciidocollab/web check:hljs-language-map

# Every `check:*` a workspace package declares must be RUN by something under scripts/ci/, and no
# workflow may invoke one directly.
#
# This is the guard for a defect this repository has now produced twice. Five drift checks
# (`check:catalogue-fonts`, `check:admonition-icons`, `check:base14-fonts`, `check:rouge-palette`,
# `check:theme-descriptors`) existed as `run:` lines inside .github/workflows/ci.yml and were invoked
# by NO script under scripts/ci/ at any opt-in level — while ci.yml states in several places that
# scripts/ci/*.sh is the single source of truth and that a green local gate means a green CI job.
# Hand-editing `packages/asciidoc-pdf/assets/rouge/palette.json` and running the whole gate,
# `RUN_WASM=1 RUN_DOCKER=1 pnpm gate`, passed every job and then failed CI.
#
# Two directions, because the two halves fail differently:
#
#   declared but unrun   — a check nobody calls. The "built and wired to nothing" shape: the code is
#                          there, it looks like coverage, and it never executes.
#   run only by a workflow — the divergence above. The check runs, but only somewhere a developer
#                          cannot reproduce, and the gate they were told to trust is silent about it.
#
# Matching is by NAME (`check:foo` appearing anywhere under scripts/ci/), not by parsing command
# lines: a gate script may reach a check through a helper, a loop or a variable, and a matcher strict
# enough to model that would break on the next refactor and be deleted. A name that appears nowhere
# cannot be being run.
#
# COMMENTS ARE STRIPPED FIRST, and that is not a detail. Written without it, the guard passed on a
# tree with scripts/ci/artifacts.sh deleted — because the comment you are reading names all five
# checks, and a naive substring match counted its own prose as evidence they were wired. Verified by
# deleting the script and watching it stay green. A check satisfied by a comment about it is the very
# failure mode this step exists to catch.
step "Every declared check:* is wired into a gate script …"
node - "$ROOT" <<'WIRING' || exit 1
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = process.argv[2];

/** Every workspace package.json, root included. */
function manifests() {
  const found = [join(root, 'package.json')];
  for (const group of ['apps', 'packages']) {
    let entries = [];
    try {
      entries = readdirSync(join(root, group));
    } catch {
      continue;
    }
    for (const name of entries) {
      const file = join(root, group, name, 'package.json');
      try {
        statSync(file);
        found.push(file);
      } catch {
        /* not a package */
      }
    }
  }
  return found;
}

/** `check:*` script names declared anywhere in the workspace, with the package that declares each. */
const declared = new Map();
for (const file of manifests()) {
  const manifest = JSON.parse(readFileSync(file, 'utf8'));
  for (const name of Object.keys(manifest.scripts ?? {})) {
    if (name.startsWith('check:')) declared.set(name, manifest.name ?? file);
  }
}

/**
 * One file's CODE: whole-line comments dropped, everything else kept. Prose describing a check must
 * not count as running it.
 *
 * LINE comments only. A first attempt also stripped C block comments, and that was worse than not
 * stripping at all: `packages/primitives/dist/*.d.ts` inside a shell `#` comment in this very file
 * opens a `/*` that the next `*\/` — hundreds of lines away, inside a JSDoc — closed, deleting the
 * two invocations in between and reporting them as unwired. Shell and YAML have no block comments to
 * strip anyway, and no JSDoc here names a check.
 */
function code(text) {
  return text
    .split('\n')
    .filter((line) => !/^\s*(#|\/\/)/.test(line))
    .join('\n');
}

/** The concatenated CODE of everything under scripts/ci/ — the gate's own definition. */
function readTree(directory) {
  let text = '';
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    text += entry.isDirectory() ? readTree(path) : code(readFileSync(path, 'utf8'));
  }
  return text;
}
const gateText = readTree(join(root, 'scripts', 'ci'));

const workflowDirectory = join(root, '.github', 'workflows');
const workflows = readdirSync(workflowDirectory).filter((name) => /\.ya?ml$/.test(name));

const problems = [];
for (const [name, owner] of [...declared].toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
  const inGate = gateText.includes(name);
  const workflowsUsing = workflows.filter((file) =>
    code(readFileSync(join(workflowDirectory, file), 'utf8')).includes(name),
  );
  if (!inGate && workflowsUsing.length > 0) {
    problems.push(
      `${owner} declares \`${name}\` and ${workflowsUsing.join(', ')} runs it, but nothing under ` +
        'scripts/ci/ does. CI would then be checking something no local gate can. Move the ' +
        'invocation into the gate script for that job and have the workflow call the script.',
    );
  } else if (!inGate) {
    problems.push(
      `${owner} declares \`${name}\` and NOTHING runs it — not scripts/ci/, not a workflow. ` +
        'A check that never executes is not coverage. Wire it into the gate script for its job.',
    );
  }
}

if (problems.length > 0) {
  console.error('[ci-quality] ERROR: declared checks are not wired into the local gate:');
  for (const problem of problems) console.error(`[ci-quality]   - ${problem}`);
  process.exit(1);
}
console.log(`[ci-quality] ${declared.size} declared check:* script(s), all reachable from scripts/ci/.`);
WIRING

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

# docker/Dockerfile names workspace packages as literal paths, and NOTHING else in the repository
# reads it: the image build is Job 10, which is opt-in behind RUN_DOCKER=1 locally and unconditional
# in CI. So a package that is renamed or retired leaves the Dockerfile pointing at a directory that no
# longer exists, every local job stays green, and the break surfaces only on the pull request.
#
# That is not hypothetical. Branch 045 retired `packages/collaboration` in its first commit and left
# `COPY packages/collaboration/package.json` in the manifests stage. Eight local gate jobs passed, the
# branch was pushed, and CI failed in 23 seconds with `"/packages/collaboration/package.json": not
# found` — a defect that needed no Docker at all to find, only something willing to read the file.
#
# Checked in BOTH directions, because they fail differently:
#
#   named but absent  — the case above. A stale path breaks the build at the first `COPY`.
#   present but uncopied — a NEW workspace package whose manifest never reaches the manifests stage.
#                          `pnpm install --frozen-lockfile` then runs against an incomplete workspace,
#                          which fails later, further from its cause, and only inside a container.
#
# Deliberately a text scan and not a Dockerfile parser: the property is "every workspace path this
# file mentions is real", and a mention is a mention wherever it appears — the manifests `COPY` lines,
# the artifacts stage's `for p in …` list, a `--filter`, a comment that has gone stale. A parser would
# see the COPY lines only, and the artifacts list is exactly where the same rename left a second dead
# reference.
step "Every workspace path named in docker/Dockerfile exists …"
node - "$ROOT" <<'DOCKERFILE_PATHS' || exit 1
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = process.argv[2];

/** Every workspace package directory, as the `group/name` path the Dockerfile would write. */
function workspacePackages() {
  const found = new Set();
  for (const group of ['apps', 'packages']) {
    let entries = [];
    try {
      entries = readdirSync(join(root, group));
    } catch {
      continue;
    }
    for (const name of entries) {
      try {
        statSync(join(root, group, name, 'package.json'));
        found.add(`${group}/${name}`);
      } catch {
        /* a directory that is not a package */
      }
    }
  }
  return found;
}

const dockerfile = join(root, 'docker', 'Dockerfile');
const text = readFileSync(dockerfile, 'utf8');
const packages = workspacePackages();

// Every `apps/<name>` or `packages/<name>` the file mentions, wherever it appears.
const named = new Set([...text.matchAll(/\b(apps|packages)\/([\w.-]+)/g)].map((m) => `${m[1]}/${m[2]}`));

const stale = [...named].filter((path) => !packages.has(path)).sort();

// The manifests stage's own copies, which is the half that has to be complete rather than merely real.
const copied = new Set(
  [...text.matchAll(/^COPY\s+(apps|packages)\/([\w.-]+)\/package\.json\s/gm)].map((m) => `${m[1]}/${m[2]}`),
);
const uncopied = [...packages].filter((path) => !copied.has(path)).sort();

if (stale.length > 0 || uncopied.length > 0) {
  for (const path of stale) {
    console.error(`[ci-quality] docker/Dockerfile names ${path}, which is not a workspace package.`);
  }
  for (const path of uncopied) {
    console.error(`[ci-quality] ${path} is a workspace package with no manifest COPY in docker/Dockerfile.`);
  }
  console.error('[ci-quality] The image build (Job 10) is the only other thing that reads this file, and it is');
  console.error('[ci-quality] opt-in locally — so this is the step that has to catch a renamed or retired package.');
  process.exit(1);
}

console.log(`[ci-quality] docker/Dockerfile: ${named.size} workspace path(s) named, all real; ${packages.size} package(s), all copied.`);
DOCKERFILE_PATHS

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
