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
