/** @type {import('jest').Config} */
const config = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['**/tests/**/*.test.ts'],
  transform: {
    // Compiled to CommonJS for the test run (tsconfig.jest-cjs.json), not the package's `node16`
    // module kind: under `node16` TypeScript preserves the WASI bridge's lazy `import()` of the
    // ESM-only interop libraries, which Jest can neither execute (it needs `--experimental-vm-modules`)
    // nor intercept with `jest.mock`. Emitting `require` there lets the adapter be unit-tested against
    // in-memory fakes; for every other module the two emit the same CommonJS output.
    '^.+\\.ts$': ['ts-jest', {
      tsconfig: 'tsconfig.jest-cjs.json',
    }],
  },
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
