/** @type {import('jest').Config} */
const config = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['**/tests/**/*.test.ts'],
  testTimeout: 120_000,
  // NO `passWithNoTests`. It used to be set here, and it turned every invocation error into a green
  // gate: a bad filter, a renamed directory, a stray `--` reaching jest as a test-path pattern — all
  // of them print "No tests found, exiting with code 0" and `scripts/ci/integration.sh` reports
  // success having run none of this package's 35 suites. That is not hypothetical; it happened.
  // An empty run of a package that HAS tests is a broken invocation, and it must fail.
  transform: {
    '^.+\\.ts$': ['ts-jest', {
      tsconfig: 'tsconfig.eslint.json',
    }],
  },
  // Without this, Istanbul builds the denominator from whatever a test happens to `require`, so a
  // source file no test imports is ABSENT from the report rather than counted as 0% — and the
  // threshold below then certifies a number that was never measured over this package's source.
  // That is exactly what happened here: 13 files (699 lines, including the password hasher, the HIBP
  // breach checker and the session store) sat outside the report entirely while it read green.
  // Exclusion-based on purpose, so a newly-added file is counted by default; an allow-list would
  // silently miss anything dropped in a location nobody remembered to list.
  collectCoverageFrom: ['src/**/*.ts', '!src/**/index.ts'],
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
