/**
 * The three Playwright configurations, held to the two properties that decide whether a CI failure
 * arrives as a diagnosis or as a shrug.
 *
 * Both were asserted only by comment until now, and both had already drifted:
 *
 *   - `playwright.render-equivalence.config.ts` had `reporter: [['line']]` unconditionally, while the
 *     workflow uploads `apps/web/playwright-report/` with `if-no-files-found: ignore`. Nothing ever
 *     wrote that directory, so the upload step ignored its way to success on every run and the
 *     artifact was empty every time. The pdf-parity config documents this exact defect at length
 *     having just been fixed there — its twin was left alone, which is what a comment cannot prevent
 *     and this test can.
 *
 *   - Neither stack-free config carried a `globalTimeout`. The per-test `timeout` bounds a hung TEST;
 *     it does not bound a RUN that stops progressing, and the job's `timeout-minutes` killing the
 *     runner leaves no report and no note of which test was in flight — a real failure replaced by a
 *     bare "timed out".
 *
 * Deliberately property-based rather than value-based: the numbers belong to each suite and are
 * argued for where they are set. What must hold everywhere is that a ceiling EXISTS, that it is under
 * the job budget that would otherwise kill the runner, and that CI gets an HTML report.
 */

import type { PlaywrightTestConfig } from '@playwright/test';

/**
 * `@playwright/test` is stubbed to the two things the configs actually import.
 *
 * Each config's reporter is chosen when the module is EVALUATED, so reading it under two different
 * environments means evaluating it twice — and `jest.isolateModules` re-requires everything the
 * module imports. The real runner package refuses that: `playwright/lib/index.js` carries a
 * module-level guard that throws `Requiring @playwright/test second time` on the second load. Nothing
 * here needs the runner, only the object the config declares, and `defineConfig` is an identity
 * function on that object.
 */
jest.mock('@playwright/test', () => ({
  defineConfig: <T,>(config: T): T => config,
  // The configs read `devices['Desktop Chrome']` and spread it; any object will do.
  devices: new Proxy({}, { get: () => ({}) }),
}));

/**
 * Load a config with `process.env.CI` forced to a value, re-evaluating the module each time.
 */
function loadConfig(relativePath: string, ci: string | undefined): PlaywrightTestConfig {
  const previous = process.env.CI;
  if (ci === undefined) delete process.env.CI;
  else process.env.CI = ci;
  try {
    let config: PlaywrightTestConfig | undefined;
    jest.isolateModules(() => {
      // `require` rather than `import`: the module has to be re-evaluated per environment, and the
      // path comes from CONFIGS below — a fixed literal list in this file, not from anywhere a caller
      // could reach.
      // eslint-disable-next-line security/detect-non-literal-require
      config = (require(relativePath) as { default?: PlaywrightTestConfig }).default;
    });
    if (config === undefined) throw new Error(`${relativePath} exported no default config`);
    return config;
  } finally {
    if (previous === undefined) delete process.env.CI;
    else process.env.CI = previous;
  }
}

/** Reporter names, flattened out of Playwright's `[name, options][]` shape. */
function reporterNames(config: PlaywrightTestConfig): string[] {
  const reporter = config.reporter;
  if (typeof reporter === 'string') return [reporter];
  if (!Array.isArray(reporter)) return [];
  return reporter.map((entry) => (typeof entry === 'string' ? entry : entry[0]));
}

/**
 * Every Playwright config in this package, with the CI job budget it runs under.
 *
 * `jobTimeoutMinutes` mirrors `.github/workflows/ci.yml`; the point of the pairing is that a
 * `globalTimeout` at or above the job budget is worth nothing — the runner would win the race and
 * destroy the report the limit exists to preserve.
 */
const CONFIGS = [
  { path: '../playwright.config.ts', job: 'e2e', jobTimeoutMinutes: 60 },
  { path: '../playwright.pdf-parity.config.ts', job: 'pdf-parity', jobTimeoutMinutes: 20 },
  { path: '../playwright.render-equivalence.config.ts', job: 'render-equivalence', jobTimeoutMinutes: 25 },
] as const;

describe.each(CONFIGS)('$path (CI job "$job")', ({ path, jobTimeoutMinutes }) => {
  it('bounds the whole run, not only each test', () => {
    const config = loadConfig(path, '1');
    expect(typeof config.globalTimeout).toBe('number');
    expect(config.globalTimeout).toBeGreaterThan(0);
  });

  it('stops itself before the runner would kill the job', () => {
    const config = loadConfig(path, '1');
    const jobBudget = jobTimeoutMinutes * 60 * 1000;
    // Strictly under, with real margin: Playwright's own stop has to leave time for it to write the
    // report and for the workflow to upload it.
    expect(config.globalTimeout).toBeLessThan(jobBudget);
  });

  it('leaves an uploadable HTML report behind on CI', () => {
    expect(reporterNames(loadConfig(path, '1'))).toContain('html');
  });

  it('stays quiet for a local run', () => {
    const names = reporterNames(loadConfig(path, undefined));
    expect(names).toContain('line');
    expect(names).not.toContain('html');
  });
});
