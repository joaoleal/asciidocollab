/** @type {import('jest').Config} */

const sharedTransform = {
  // Transform .js too (with allowJs) so the generated Lezer parser (`asciidoc-parser.js`,
  // ESM) and the modules that import it can load under the commonjs jest runtime.
  '^.+\\.(ts|tsx|js)$': ['ts-jest', {
    tsconfig: {
      jsx: 'react-jsx',
      module: 'commonjs',
      moduleResolution: 'node',
      esModuleInterop: true,
      resolveJsonModule: true,
      allowJs: true,
      rootDir: '.',
      ignoreDeprecations: '6.0',
      paths: {
        '@/*': ['./src/*'],
      },
    },
  }],
};

// The @dicebear/* packages ship as pure ESM `.js`, which the commonjs jest runtime cannot parse.
// Now that `@/components/avatar` is imported transitively by the review rail and the editor layout,
// their unit tests would fail to load it. Un-ignore the `@dicebear+*` pnpm dirs so ts-jest compiles
// them (the currently-installed @dicebear packages declare no runtime deps, so this covers the whole
// graph; if a future bump adds a non-@dicebear ESM dep, widen the negative lookahead). Suites that
// stub the avatar still `jest.mock('@dicebear/core')` per file, which overrides the real module.
const transformIgnorePatterns = ['/node_modules/\\.pnpm/(?!@dicebear\\+)'];

const sharedModuleNameMapper = {
  '^@/(.*)$': '<rootDir>/src/$1',
  // Resolve the shared AsciiDoc leaf packages from source so unit tests don't require a prior build.
  '^@asciidocollab/asciidoc-core$': '<rootDir>/../../packages/asciidoc-core/src/index.ts',
  '^@asciidocollab/asciidoc-pdf$': '<rootDir>/../../packages/asciidoc-pdf/src/index.ts',
  '\\.css$': '<rootDir>/tests/__mocks__/fileMock.cjs',
};

// Coverage measures application source only. Test infrastructure — Playwright
// e2e helpers and jest test helpers/mocks — is not application code and must
// not count toward (or against) the thresholds below. This is a project-level
// option, so it must live inside each project entry (not at the root).
const coveragePathIgnorePatterns = ['/node_modules/', '<rootDir>/e2e/', '<rootDir>/tests/'];

// Enforce coverage over ALL application source (matching the monorepo convention
// where domain/api/shared set `collectCoverageFrom: src/**`). Without this, the
// global threshold below only measures files a test happens to import, so a brand-new
// module with no test would silently pass the gate. This list is EXCLUSION-based
// (`src/**` then `!…`) so any newly-added file is counted by default — an allow-list
// would silently miss new files in unlisted locations.
const collectCoverageFrom = [
  'src/**/*.{ts,tsx}',
  // The only exclusions are files that physically cannot be loaded as modules under the
  // jest runtime — Web/Shared Worker entry scripts (worker-global scope: `onconnect`,
  // `self`, no module exports) and the render-worker factory (`new Worker(new URL(...,
  // import.meta.url))`, which `import.meta` makes unloadable under the commonjs transform;
  // it exists precisely so consumers MOCK it). Everything else is unit-tested — including the
  // render-worker holder, whose lifetime policy is unit-tested against the mocked spawn factory.
  '!src/**/*.worker.ts',
  '!src/lib/spawn-render-worker.ts',
  '!src/lib/create-pdf-worker.ts',
  // Grammar-worker factory: `new Worker(new URL(…, import.meta.url))` again, unloadable under the
  // commonjs transform and existing precisely so consumers MOCK it. The engine behaviour it wires up
  // lives in `harper-engine-proxy.ts` (unit-tested against a fake worker) and in the worker entry
  // itself (excluded above with the other worker scripts, and verified in a real browser).
  '!src/lib/create-harper-worker.ts',
  // Ambient type declarations carry no runtime code — they are not loadable modules.
  '!src/**/*.d.ts',
];

const config = {
  collectCoverageFrom,
  projects: [
    {
      displayName: 'node',
      testEnvironment: 'node',
      // Exclude `*.integration.test.ts`: those load the REAL self-hosted MathJax bundle, which
      // pollutes the shared worker's module/global state and collides with the unit suites that
      // VIRTUAL-mock the same `mathjax/es5/*` paths. They run in their own project (below) so the
      // two never share a worker.
      testMatch: ['**/tests/**/*.test.ts'],
      testPathIgnorePatterns: ['/node_modules/', '\\.integration\\.test\\.ts$'],
      transform: sharedTransform,
      transformIgnorePatterns,
      moduleNameMapper: sharedModuleNameMapper,
      // Also loaded for node-project tests so the editor `.test.ts` files that opt
      // into jsdom via a `/* @jest-environment jsdom */` pragma still get jest-dom
      // matchers + the matchMedia polyfill (harmless in a pure-node test).
      setupFilesAfterEnv: ['<rootDir>/tests/jest-setup.ts'],
      collectCoverageFrom,
      coveragePathIgnorePatterns,
    },
    {
      displayName: 'jsdom',
      testEnvironment: 'jsdom',
      testMatch: ['**/tests/**/*.test.tsx'],
      transform: sharedTransform,
      transformIgnorePatterns,
      moduleNameMapper: sharedModuleNameMapper,
      setupFilesAfterEnv: ['<rootDir>/tests/jest-setup.ts'],
      collectCoverageFrom,
      coveragePathIgnorePatterns,
    },
    {
      // Integration suites that load the REAL self-hosted MathJax bundle (no mock) to validate the
      // actual delimiter→input-jax wiring. Isolated in their own project so the real bundle's global
      // side effects never leak into the virtual-mocked unit suites.
      displayName: 'integration',
      testEnvironment: 'jsdom',
      testMatch: ['**/tests/**/*.integration.test.ts'],
      transform: sharedTransform,
      transformIgnorePatterns,
      moduleNameMapper: sharedModuleNameMapper,
      setupFilesAfterEnv: ['<rootDir>/tests/jest-setup.ts'],
      collectCoverageFrom,
      coveragePathIgnorePatterns,
    },
  ],
  coverageThreshold: {
    global: {
      statements: 90,
      branches: 90,
      functions: 90,
      lines: 90,
    },
  },
};

module.exports = config;
