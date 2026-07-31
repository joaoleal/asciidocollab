import { defineConfig, devices } from '@playwright/test';

/**
 * Standalone Playwright config for the PDF reference-parity render suite. Unlike the main e2e config it
 * needs NO running app stack and NO auth setup: the suite drives the wasm engine + rendering shims
 * directly (Node) and a blank browser page (for the DOM-bound mermaid/MathJax shims), then compares the
 * produced PDF against the committed reference build. It is a separate config precisely so it never
 * depends on the `setup` project or a live web server; from the web package it is run directly with
 * `pnpm exec playwright test --config playwright.pdf-parity.config.ts`.
 * The suite self-gates: it skips cleanly when the wasm engine or a fixture's reference PDF is absent.
 */
export default defineConfig({
  testDir: './e2e/pdf-parity',
  // Both the comparison suite and the (hard-gated, PARITY_EMIT-only) reference-input emitter live here;
  // the emitter self-skips unless PARITY_EMIT=1, so a normal run only executes the comparison suite.
  // The internal-link spec verifies a harness measurement against the committed reference PDFs; it
  // needs neither the engine nor a browser, and is listed here so the same CI job that owns this
  // directory runs it (a spec no configuration selects would verify nothing).
  testMatch: [
    '**/pdf-parity-render.spec.ts',
    '**/emit-reference-inputs.spec.ts',
    '**/internal-link-targets.spec.ts',
  ],
  // The engine cold-start (compile + boot of a ~70 MiB wasm module) plus multiple headless converts and
  // poppler rasterization make these tests inherently slow; give each generous headroom.
  timeout: 240_000,
  // The warm engine VM and the heavy wasm compile are serialized: one worker avoids running several
  // 70 MiB VMs at once.
  workers: 1,
  fullyParallel: false,
  reporter: [['line']],
  projects: [
    {
      name: 'pdf-parity',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
