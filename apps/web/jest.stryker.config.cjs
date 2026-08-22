/** @type {import('jest').Config} */

// Jest configs for the two Stryker runs (see stryker.node.config.json / stryker.jsdom.config.json).
//
// WHY TWO. StrykerJS's jest-runner does not honour jest's `projects`: it flattens them, so a `.tsx`
// suite ends up in the `node` environment and dies with "document is not defined" during the dry
// run. Verified here — plain `jest --config` over the same multi-project object runs 387 suites /
// 6251 tests green, while Stryker over it aborts before mutating anything. So the environment split
// has to become a run split.
//
// WHY NOT ONE jsdom RUN. That is what this file used to be, and it is why `pnpm mutate` was dead:
// `src/lib/api/*.ts` is fetch-based and jsdom supplies neither `fetch` nor `Request`, so those
// suites failed the dry run outright. The old config had also silently rotted away from the real
// jest.config.cjs (no `transformIgnorePatterns` for the pure-ESM @dicebear packages, no
// `allowJs`/`resolveJsonModule` for the generated Lezer parser), which is a second, independent
// reason the dry run could never pass. Everything below is DERIVED from jest.config.cjs so that
// drift cannot silently return.
//
// SCOPING. Each run's `testMatch` is narrowed to the suites that exercise its mutate glob. With
// `coverageAnalysis: "perTest"` Stryker already runs only the tests covering each mutant, so this
// costs almost nothing — and where it does cost something it can only UNDER-count kills (a mutant
// killed by a test outside the scope reads as survived), never over-count. That is the safe
// direction for a quality gate.
const fs = require('node:fs');
const path = require('node:path');

const baseConfig = require('./jest.config.cjs');

// Which `.test.ts` files opt into jsdom with a `/* @jest-environment jsdom */` docblock.
//
// This split has to exist and it has to be computed, not listed. Jest resolves a docblock
// environment through its OWN resolver, so neither `testEnvironment` in the config nor a
// `moduleNameMapper` redirect can reach it — those files always get the stock `jest-environment-jsdom`,
// which does not report per-test coverage, and Stryker aborts the dry run with "Missing coverage
// results for: …" naming all 41 of them. Since they are jsdom suites, they belong in the jsdom run;
// the node run must skip them. Scanning for the docblock keeps that correct as files are added or
// their docblock removed — a hand-maintained list would rot exactly the way this file already did once.
function testsByDocblockEnvironment(directory, found = { jsdom: [], node: [] }) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      testsByDocblockEnvironment(full, found);
    } else if (entry.name.endsWith('.test.ts')) {
      // Only the leading docblock counts; jest reads the first comment block of the file.
      const declared = /@jest-environment\s+(jsdom|node)/.exec(fs.readFileSync(full, 'utf8').slice(0, 2000));
      if (declared) found[declared[1]].push(full);
    }
  }
  return found;
}

const TESTS_DIRECTORY = path.join(__dirname, 'tests');
const DOCBLOCK_TESTS = testsByDocblockEnvironment(TESTS_DIRECTORY);
const JSDOM_DOCBLOCK_FILES = DOCBLOCK_TESTS.jsdom.map((file) => path.relative(__dirname, file));

// An explicit `@jest-environment` docblock is the one case this config cannot rescue, whichever
// environment it names. Jest resolves a docblock environment through its OWN resolver, so it beats
// both `testEnvironment` in the config and a `moduleNameMapper` redirect — the suite always gets the
// STOCK jsdom/node environment, which reports no per-test coverage, and Stryker aborts the entire
// run with "Missing coverage results for: …". Such a suite cannot take part in mutation testing at
// all and is dropped from both runs.
//
// That is a real loss of signal (a mutant these suites would have killed now reads as survived), so
// it is announced rather than applied quietly — a silent drop here is exactly the kind of thing that
// makes a quality gate measure less than it claims. Keep this list as short as you can: a suite that
// does not actually need the docblock should lose it and inherit the project environment instead.
const NODE_DOCBLOCK_FILES = DOCBLOCK_TESTS.node.map((file) => path.relative(__dirname, file));
const DOCBLOCK_EXCLUDED = [...JSDOM_DOCBLOCK_FILES, ...NODE_DOCBLOCK_FILES];
if (DOCBLOCK_EXCLUDED.length > 0) {
  console.warn(
    `[stryker] excluding ${DOCBLOCK_EXCLUDED.length} suite(s) with an explicit '@jest-environment' docblock — ` +
      'the stock environment reports no per-test coverage, so Stryker cannot run them.',
  );
}
// Two forms of the same list: regex fragments to EXCLUDE from the node run, and `<rootDir>`-relative
// globs to INCLUDE in the jsdom run. Both are anchored on the package-relative path so they keep
// matching inside Stryker's sandbox copy, where the absolute prefix differs.
// Suites that read a real asset from OUTSIDE this package by a path relative to the package root
// (`packages/asciidoc-pdf/assets/fonts/*.woff2`, the generated print-highlight CSS, the hljs language
// map). Stryker runs from `.stryker-tmp/sandbox-XXXX/`, which holds apps/web only, so those paths
// resolve inside the sandbox and the reads fail with ENOENT — taking the whole dry run down with them.
//
// None of the three exercises anything in either mutate glob (they cover print-preview, styles and
// the render worker), so dropping them costs no kill signal for the mutated files. Listed explicitly
// rather than pattern-matched so that adding a fourth is a deliberate act, and announced below for
// the same reason the docblock exclusions are.
const SANDBOX_UNREACHABLE_ASSET_TESTS = [
  'tests/lib/print-preview/font-metrics.test.ts',
  'tests/styles/print-highlight-generated.test.ts',
  'tests/workers/hljs-language-map.test.ts',
];
console.warn(
  `[stryker] excluding ${SANDBOX_UNREACHABLE_ASSET_TESTS.length} suite(s) that read assets outside this ` +
    'package — unreachable from the Stryker sandbox:\n  ' + SANDBOX_UNREACHABLE_ASSET_TESTS.join('\n  '),
);

// One exclusion list, applied to BOTH runs — anything jest cannot drive under a coverage-reporting
// environment, plus the suites whose assets the sandbox cannot reach.
const EXCLUDED_FROM_MUTATION = [...DOCBLOCK_EXCLUDED, ...SANDBOX_UNREACHABLE_ASSET_TESTS].map(
  (file) => file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$',
);

const projectByName = Object.fromEntries(
  baseConfig.projects.map((project) => [project.displayName, project]),
);

// Stryker copies the project into `.stryker-tmp/sandbox-XXXX/`, and `<rootDir>` points at that copy,
// which contains apps/web only. The real config maps the two shared AsciiDoc leaf packages to
// `<rootDir>/../../packages/...` so unit tests need no prior build; inside the sandbox that resolves
// to `apps/web/.stryker-tmp/packages/...`, which does not exist, and jest aborts the whole run with
// "Could not locate module … mapped as …". Dropping the two entries makes jest resolve them through
// `node_modules/@asciidocollab/*` — pnpm workspace symlinks that escape the sandbox — i.e. against
// their BUILT dist. So a mutation run requires `pnpm -r build` first, which every CI job already does.
const SANDBOX_UNSAFE_MAPPINGS = new Set([
  '^@asciidocollab/asciidoc-core$',
  '^@asciidocollab/asciidoc-pdf$',
]);

// `coverageAnalysis: "perTest"` needs the test environment to report per-test coverage back to
// Stryker, which the stock `node`/`jsdom` environments do not do — Stryker aborts the dry run with
// "You probably configured a test environment in jest that is not reporting code coverage".
// Substituting the environment in the config only covers suites that state no preference: 38+ of
// this package's `.test.ts` files opt into jsdom with a `/* @jest-environment jsdom */` docblock,
// and jest resolves that name to the `jest-environment-jsdom` MODULE, bypassing the config. The
// moduleNameMapper entry below redirects that resolution, so the docblock suites get the reporting
// environment too — without editing 38 test files to name a mutation-testing-specific environment.
const STRYKER_JSDOM_ENV = '@stryker-mutator/jest-runner/jest-env/jsdom';
const STRYKER_NODE_ENV = '@stryker-mutator/jest-runner/jest-env/node';

/** Copies a project entry, dropping the module mappings that cannot resolve inside a sandbox. */
function forSandbox(project, overrides) {
  return {
    ...project,
    ...overrides,
    moduleNameMapper: {
      ...Object.fromEntries(
        Object.entries(project.moduleNameMapper).filter(([pattern]) => !SANDBOX_UNSAFE_MAPPINGS.has(pattern)),
      ),
      '^jest-environment-jsdom$': STRYKER_JSDOM_ENV,
      '^jest-environment-node$': STRYKER_NODE_ENV,
    },
  };
}

/**
 * Config for the `node`-environment run: the fetch-based API clients and the filesystem walker.
 * `displayName`/`projects` are deliberately absent — a flat config is the only shape the jest-runner
 * drives correctly.
 */
// Scoped to `.test.ts` only — which is exactly the real `node` project's own testMatch. It is NOT
// narrowed further to `tests/lib/api/**`: eight of the sixteen API clients (admin, assets, auth,
// file-content, grammar, members, pdf-extensions, users) have no suite of their own under that
// directory and are exercised from component and page tests instead, so narrowing reported 269
// mutants as "no coverage" that are in fact covered. The `.tsx` suites stay out because they are
// what breaks a Stryker run: the jest-runner flattens `projects`, so a `.tsx` file lands in this
// node environment and dies on `document is not defined`.
const nodeConfig = forSandbox(projectByName.node, {
  testMatch: ['**/tests/**/*.test.ts'],
  testPathIgnorePatterns: [...projectByName.node.testPathIgnorePatterns, ...EXCLUDED_FROM_MUTATION],
  testEnvironment: STRYKER_NODE_ENV,
});
delete nodeConfig.displayName;

/**
 * Config for the `jsdom`-environment run: the React hooks. Both `.ts` and `.tsx` hook suites are
 * matched — several `use-editor-preferences.*.test.ts` files are jsdom suites that opt in with a
 * `@jest-environment` docblock, and leaving them out would under-count kills for that hook.
 */
const jsdomConfig = forSandbox(projectByName.jsdom, {
  // `.tsx` only. The jsdom-docblock `.test.ts` suites would belong here by environment, but they
  // cannot report coverage (see above), so they are excluded rather than allowed to abort the run.
  testMatch: ['**/tests/**/*.test.tsx'],
  testPathIgnorePatterns: [
    ...(projectByName.jsdom.testPathIgnorePatterns ?? ['/node_modules/']),
    ...EXCLUDED_FROM_MUTATION,
  ],
  testEnvironment: STRYKER_JSDOM_ENV,
});
delete jsdomConfig.displayName;

module.exports = { nodeConfig, jsdomConfig };
