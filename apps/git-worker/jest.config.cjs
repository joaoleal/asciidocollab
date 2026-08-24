/** @type {import('jest').Config} */
const config = {
  testEnvironment: 'node',
  testMatch: ['**/tests/**/*.test.ts'],
  testTimeout: 120_000,
  // ESM mode: ts-jest emits ESM and jest loads it under --experimental-vm-modules (see test script).
  extensionsToTreatAsEsm: ['.ts'],
  // Source files use explicit .js specifiers (NodeNext); strip them so jest resolves the .ts source.
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  // Native ESM does not inject the `jest` global — expose it for all specs (see jest-setup.ts).
  setupFilesAfterEnv: ['<rootDir>/tests/jest-setup.ts'],
  transform: {
    '^.+\\.ts$': ['ts-jest', {
      useESM: true,
      tsconfig: 'tsconfig.eslint.json',
    }],
  },
  collectCoverageFrom: ['src/**/*.ts', '!src/index.ts'],
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
