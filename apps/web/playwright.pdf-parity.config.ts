import { defineConfig, devices } from '@playwright/test';

/**
 * Standalone Playwright config for the PDF reference-parity render suite. Unlike the main e2e config it
 * needs NO running app stack and NO auth setup: the suite drives the wasm engine + rendering shims
 * directly (Node) and a blank browser page (for the DOM-bound mermaid/MathJax shims), then compares the
 * produced PDF against the committed reference build. It is a separate config precisely so it never
 * depends on the `setup` project or a live web server; from the web package it is run directly with
 * `pnpm exec playwright test --config playwright.pdf-parity.config.ts`.
 * The suite self-gates on the wasm engine: it skips cleanly when the engine has not been built. It does
 * NOT extend that leniency to a missing reference PDF — a reference the repository is committed to and
 * that has gone missing fails the suite, since a skip there is a comparison silently deleted.
 */
export default defineConfig({
  testDir: './e2e/pdf-parity',
  // EVERY spec under `testDir`, by directory rather than by name. The default config ignores
  // `**/pdf-parity/**` wholesale, so this config is the SOLE selector for this tree: a spec listed here
  // by name and then forgotten would be run by no configuration at all and would verify nothing. That
  // is not hypothetical — naming the pdf-parity specs file by file in the DEFAULT config is what made
  // 153 of them run twice, under a 45s budget against a stack they never use, until it was found by
  // review. Directory-scoped selection cannot drift as the directory grows.
  //
  // What lives here: the comparison suite; the hard-gated reference-input emitter (self-skips unless
  // PARITY_EMIT=1); the internal-link spec, which checks a harness measurement against the committed
  // reference PDFs and needs neither the engine nor a browser; and the Print preview's fidelity oracle,
  // which is stack-free by construction — it converts the fixture with Asciidoctor in Node and dresses
  // the result in the shipped stylesheet on a blank page, so what it measures is the styling under test
  // rather than a whole running application.
  testMatch: ['**/*.spec.ts'],
  // The engine cold-start (compile + boot of a ~70 MiB wasm module) plus multiple headless converts and
  // poppler rasterization make these tests inherently slow; give each generous headroom.
  timeout: 240_000,
  // The warm engine VM and the heavy wasm compile are serialized: one worker avoids running several
  // 70 MiB VMs at once.
  workers: 1,
  fullyParallel: false,
  // Whole-RUN ceiling. The per-test `timeout` above bounds a test that hangs; it does not bound a RUN
  // that stops making progress — a wedged worker between tests, a wasm VM that never returns, a suite
  // that stalls after the engine boot. In that state the run sits until the job's `timeout-minutes`
  // kills the runner, and a runner kill leaves no report and no note of which test was in flight: a
  // real failure is replaced by a bare "timed out". Playwright stopping itself prints what was
  // running and leaves the HTML report for the workflow to upload, which is why this is set BELOW the
  // job budget rather than at it. Same reasoning as playwright.config.ts:66-79.
  //
  // SIZED FROM A MEASUREMENT, not a guess, because the suite grew: this branch took it to 201 tests
  // in 16 files (26 reference-parity renders through the wasm engine + poppler, and 166 print-fidelity
  // assertions). A full local run — one worker, warm engine, 196 passed / 1 failed / 4 skipped — took
  // 67 seconds of wall clock. Ten minutes is ~9x that, which is headroom for a CI runner several
  // times slower than the machine measured on AND for a run that fails honestly: at the 240 s
  // per-test budget above, two tests can burn their entire deadline and the run still reaches the end
  // and reports which assertion failed. A ceiling that truncates a real failure is worse than none.
  //
  // The job budget it sits under is .github/workflows/ci.yml's `pdf-parity` job (`timeout-minutes:
  // 20`), which also has to cover checkout, install, the workspace build and the engine restore —
  // none of which this limit sees. The ~10-minute gap between the two is what keeps the diagnostic.
  globalTimeout: 10 * 60 * 1000,
  // On CI the `line` reporter's output exists only in the job log, and the job log is exactly what a
  // triager does not have once the run has scrolled past — so the workflow's "Upload Playwright
  // report" step (.github/workflows/ci.yml:455-462) publishes `apps/web/playwright-report/` with
  // `if-no-files-found: ignore`. With `line` as the only reporter nothing ever wrote that directory,
  // so the step ignored its way to success and every pdf-parity failure landed with an EMPTY
  // artifact. Adding the html reporter is what fills it: the default output folder is
  // `playwright-report/` beside this config, which is the path the workflow already uploads.
  //
  // Mirrors playwright.config.ts:95 exactly, `open: 'never'` included — on CI there is no browser to
  // open the report in, and the default `open: 'on-failure'` would have the run try. Locally the
  // reporter is unchanged (`line` only), so a developer's run stays quiet and writes no report tree.
  reporter: process.env.CI ? [['line'], ['html', { open: 'never' }]] : [['line']],
  projects: [
    {
      name: 'pdf-parity',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
