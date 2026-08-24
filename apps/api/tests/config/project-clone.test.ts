import { createConfig } from '../../src/config/schema';

/**
 * Cloning copies an entire project per request, making it the heaviest project
 * operation in the system and an amplifying route that MUST be limited. The
 * budget is config-driven (no hardcoded literals) and overridable per
 * deployment. These tests pin the schema defaults and the
 * ASCIIDOCOLLAB_PROJECT_CLONE_* environment bindings.
 */
describe('project.clone config', () => {
  const cloneEnvironmentKeys = [
    'ASCIIDOCOLLAB_PROJECT_CLONE_RATE_LIMIT_MAX',
    'ASCIIDOCOLLAB_PROJECT_CLONE_RATE_LIMIT_WINDOW',
  ] as const;

  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of cloneEnvironmentKeys) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of cloneEnvironmentKeys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it('exposes documented defaults', () => {
    expect(createConfig().get('project.clone')).toEqual({
      rateLimitMax: 20,
      rateLimitWindow: 3_600_000,
    });
  });

  it('stays below the refactoring budget, the next-heaviest project operation', () => {
    const config = createConfig();
    expect(config.get('project.clone').rateLimitMax).toBeLessThan(
      config.get('project.refactoring').rateLimitMax,
    );
  });

  it('binds both budgets to their ASCIIDOCOLLAB_PROJECT_CLONE_* env var', () => {
    process.env.ASCIIDOCOLLAB_PROJECT_CLONE_RATE_LIMIT_MAX = '7';
    process.env.ASCIIDOCOLLAB_PROJECT_CLONE_RATE_LIMIT_WINDOW = '11';

    expect(createConfig().get('project.clone')).toEqual({
      rateLimitMax: 7,
      rateLimitWindow: 11,
    });
  });
});
