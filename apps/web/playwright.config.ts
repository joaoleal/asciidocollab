import { defineConfig, devices } from '@playwright/test';

const WEB_URL = process.env.NEXT_PUBLIC_WEB_URL ?? 'http://localhost:3000';

export default defineConfig({
  testDir: './e2e',
  // Per-test budget. Kept generous so a COLD first render — the AsciiDoc→HTML web worker and Yjs
  // sync warming up on the first preview/editor mount after the stack starts — has room to complete
  // within a single attempt under gate load, rather than tripping the deadline and surfacing as a
  // flaky retry. Steady-state tests finish in a few seconds; only cold starts approach this.
  timeout: 45_000,
  retries: process.env.CI ? 2 : 0,
  // Cap concurrency for the isolated stack: every collab-backed test opens Yjs sync session(s) against
  // a SINGLE test collaboration server, and collab pair-tests use two browser contexts each. The
  // Playwright default (one worker per CPU core) over-subscribes that server on a many-core machine, so
  // its Yjs sync lags and content-dependent assertions race an empty pre-sync document — surfacing as
  // intermittent failures in the heavy collab+preview specs (preview render, file-restore, outline).
  // 3 keeps the collab server within sync budget under gate load — 4 still let the post-navigation
  // re-sync lag past even the generous per-spec waits (observed as retried "preview render" / restore
  // flakes) — while staying reasonably fast. The cap is applied UNCONDITIONALLY (not only under CI): a
  // bare local `npx playwright test` must not oversubscribe either. Override with PLAYWRIGHT_WORKERS
  // when you know the run won't contend (e.g. a single spec).
  workers: process.env.PLAYWRIGHT_WORKERS ? Number(process.env.PLAYWRIGHT_WORKERS) : 3,
  // `line` for readable console output everywhere; in CI also emit the self-contained HTML report
  // (traces/screenshots are copied into playwright-report/) that the workflow uploads as an artifact
  // for debugging failures. `open: 'never'` so a failing CI run doesn't try to launch a browser.
  reporter: process.env.CI ? [['line'], ['html', { open: 'never' }]] : [['line']],
  use: {
    baseURL: WEB_URL,
    trace: 'on-first-retry',
  },
  projects: [
    // Phase 1: First-run test must run before any other test creates users.
    // auth-first-run.spec.ts checks isConfigured() and registers the first admin
    // user (TEST_USER) on an empty database. All other projects depend on this so
    // they start with a known-good user in the database.
    {
      name: 'setup',
      testMatch: '**/auth-first-run.spec.ts',
    },

    // Phase 2a: Email-verification tests enable/disable openRegistration to create
    // unverified users. Runs after setup, concurrently with chromium (chromium tests
    // never touch openRegistration).
    {
      name: 'email-gate',
      use: { ...devices['Desktop Chrome'] },
      testMatch: '**/email-verification-gate.spec.ts',
      dependencies: ['setup'],
    },

    // Phase 2b: Open-registration toggle tests also mutate openRegistration. By
    // declaring email-gate as a dependency they are guaranteed to run AFTER email-gate
    // finishes, eliminating the concurrent-mutation race condition on that setting.
    {
      name: 'open-reg-toggle',
      use: { ...devices['Desktop Chrome'] },
      testMatch: '**/open-registration-toggle.spec.ts',
      dependencies: ['email-gate'],
    },

    // Phase 2c: All remaining tests. No dependency on openRegistration — safe to
    // run concurrently with email-gate and open-reg-toggle.
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
      testIgnore: [
        '**/auth-first-run.spec.ts',
        '**/email-verification-gate.spec.ts',
        '**/open-registration-toggle.spec.ts',
        // Run under their own stack-free config (playwright.pdf-parity.config.ts): they drive the wasm
        // engine + shims directly and must not depend on the `setup` project or a live web server. The
        // emit spec additionally shells out to Docker (PARITY_EMIT-gated) and is a dev tool, not a check.
        '**/pdf-parity-render.spec.ts',
        '**/emit-reference-inputs.spec.ts',
        // The heavy in-browser PDF preview spec runs in its own single-worker project (below): it spins
        // up a tens-of-MiB wasm engine, so running it alongside the rest under the shared worker cap
        // thrashes the box and the large same-origin blob fetch aborts. It stays against the live stack,
        // just serialized — NOT excluded from the run.
        '**/pdf-preview-responsive.spec.ts',
        '**/pdf-image-embed.spec.ts',
        '**/pdf-extensions.spec.ts',
      ],
      dependencies: ['setup'],
    },

    // Phase 2d: The heavy in-browser PDF preview spec, run one-at-a-time. It boots a fresh wasm engine
    // (tens of MiB compiled + a warm Ruby VM), so this project pins `workers: 1` / `fullyParallel:
    // false` to keep only ONE engine alive at a time — concurrent engines starve each other and abort
    // the engine-blob fetch. It still exercises the real app stack (it depends on `setup`); only the
    // concurrency is capped for this project, not for the whole suite.
    {
      name: 'chromium-pdf',
      use: { ...devices['Desktop Chrome'] },
      testMatch: [
        '**/pdf-preview-responsive.spec.ts',
        '**/pdf-image-embed.spec.ts',
        // Exports a real PDF per assertion, so it boots the same engine — and additionally shares one
        // administrator drop folder across its tests, which only a single worker can be trusted with.
        // Left in the default project it failed all three retries under gate load while passing alone,
        // which is precisely the starvation this project exists to prevent.
        '**/pdf-extensions.spec.ts',
      ],
      workers: 1,
      fullyParallel: false,
      // Under the gate (CI=1) this project runs AFTER `chromium`, not concurrently with it. `workers:
      // 1` keeps only one wasm engine alive WITHIN this project, but nothing stopped the whole project
      // from overlapping the 3-worker `chromium` project — so a tens-of-MiB engine rendering a PDF
      // export competed with the preview/editor suite for the same cores. Under peak gate load that
      // mutual starvation surfaced as retried timeouts on BOTH sides: the export's `download` event
      // (here) and, over in `chromium`, cold preview renders and editor mounts (preview-conditionals,
      // rename-suggestion-timing). Serializing the two phases removes the contention at its source
      // rather than widening timeouts around it. Locally (CI unset) the dependency stays light so a
      // single `npx playwright test pdf-extensions.spec.ts` does not drag the whole `chromium` suite in
      // first — the box is not contended there, which is the only reason the overlap was ever safe.
      dependencies: process.env.CI ? ['chromium'] : ['setup'],
    },
  ],
});
