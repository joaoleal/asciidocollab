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
  // Whole-RUN ceiling, which the per-test `timeout` above is not. A worker wedged between tests, a
  // reference container build that stops answering, a retry storm — none of those trip a per-test
  // deadline, and the run then sits until the CI job's `timeout-minutes` kills it. That kill produces
  // no report and no indication of which test was still running: a real failure is replaced by a bare
  // "the job timed out". Playwright stopping itself prints what was in flight and leaves the HTML
  // report below for the workflow to upload, so this limit is deliberately set BELOW the job budget
  // (.github/workflows/ci.yml, render-equivalence `timeout-minutes: 25`) and the gap is what keeps
  // that diagnostic. Same reasoning, and the same 10-minute margin, as playwright.config.ts:66-79.
  globalTimeout: 15 * 60 * 1000,
  // On CI the `line` reporter's output exists only in the job log, and the job log is exactly what a
  // triager does not have once the run has scrolled past — so the workflow's "Upload Playwright
  // report" step publishes `apps/web/playwright-report/` with `if-no-files-found: ignore`. With
  // `line` as the only reporter NOTHING EVER WROTE that directory, so the step ignored its way to
  // success on every run and every render-equivalence failure landed with an empty artifact. This is
  // the identical defect that playwright.pdf-parity.config.ts documents having just been fixed; its
  // twin was left alone. Adding the html reporter is what fills the directory: its default output
  // folder is `playwright-report/` beside this config, which is the path the workflow already
  // uploads.
  //
  // Mirrors playwright.config.ts and the pdf-parity config exactly, `open: 'never'` included — on CI
  // there is no browser to open the report in, and the default `open: 'on-failure'` would have the
  // run try. Locally the reporter is unchanged (`line` only), so a developer's run stays quiet and
  // writes no report tree.
  reporter: process.env.CI ? [['line'], ['html', { open: 'never' }]] : [['line']],
  projects: [
    {
      name: 'render-equivalence',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
