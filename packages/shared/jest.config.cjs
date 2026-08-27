/** @type {import('jest').Config} */
const config = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['**/tests/**/*.test.ts'],
  // Order the wall-clock performance suites (tests/print-appearance) first so they run on a clean
  // heap; see jest-perf-first-sequencer.cjs. The gate runs this package with --runInBand for the
  // same reason (scripts/ci/unit.sh), which CI shares as its single source of truth.
  testSequencer: '<rootDir>/jest-perf-first-sequencer.cjs',
  collectCoverageFrom: ['src/**/*.ts'],
  transform: {
    '^.+\\.ts$': ['ts-jest', {
      tsconfig: 'tsconfig.eslint.json',
    }],
  },
  coverageThreshold: {
    global: {
      branches: 90,
      functions: 90,
      lines: 90,
      statements: 90,
    },
  },
};

module.exports = config;
