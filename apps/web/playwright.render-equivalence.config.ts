import { defineConfig, devices } from '@playwright/test';

/**
 * Standalone Playwright config for the render-equivalence suite.
 *
 * Like the PDF-parity config, and for the same reasons, it needs NO running app stack and NO auth
 * setup: these specs drive the render worker directly in Node and compare its output against captured
 * fixtures and the canonical reference build. Keeping them off the main config means they never depend
 * on the `setup` project or a live web server, and a failure here is unambiguously a rendering
 * difference rather than a stack problem.
 *
 * From the web package, run it with
 * `pnpm exec playwright test --config playwright.render-equivalence.config.ts`.
 */
export default defineConfig({
  testDir: './e2e/render-equivalence',
  // The capture spec self-skips unless CAPTURE_PREVIOUS_ENGINE=1, so a normal run only executes the
  // comparison gates.
  testMatch: ['**/*.spec.ts'],
  // Converting the whole corpus through a real Asciidoctor (and, for the reference gate, a container
  // build) is slow enough that the default budget would fail on cold runs rather than on differences.
  timeout: 240_000,
  workers: 1,
  fullyParallel: false,
  reporter: [['line']],
  projects: [
    {
      name: 'render-equivalence',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
