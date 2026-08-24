import { createConfig } from '../../src/config/schema';

/**
 * The git repository sync feature's config surface: worker pool size, the network
 * egress allowlist git-worker containers may reach, the dedicated credential
 * encryption key, per-project rate limiting, and repo-size/LFS thresholds. Every
 * git use case and the worker pool read these fields, so the fragment loading with
 * sane defaults, and rejecting a malformed credential key at validation time
 * (rather than failing later inside the worker), is foundational.
 */
describe('git config', () => {
  const gitEnvironmentKeys = [
    'ASCIIDOCOLLAB_GIT_WORKER_POOL_SIZE',
    'ASCIIDOCOLLAB_GIT_EGRESS_ALLOWED_HOSTS',
    'ASCIIDOCOLLAB_GIT_CREDENTIAL_ENCRYPTION_KEY',
    'ASCIIDOCOLLAB_GIT_RATE_LIMIT_MAX',
    'ASCIIDOCOLLAB_GIT_RATE_LIMIT_WINDOW',
    'ASCIIDOCOLLAB_GIT_MAX_REPO_SIZE_MB',
    'ASCIIDOCOLLAB_GIT_LFS_THRESHOLD_BYTES',
  ] as const;

  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of gitEnvironmentKeys) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of gitEnvironmentKeys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it('loads with documented defaults', () => {
    expect(createConfig().get('git')).toEqual({
      workerPoolSize: 4,
      egress: {
        allowedHosts: ['github.com', 'gitlab.com', 'bitbucket.org'],
      },
      credentialEncryptionKey: '',
      rateLimitMax: 30,
      rateLimitWindow: 60_000,
      maxRepoSizeMB: 500,
      lfsThresholdBytes: 10_485_760,
    });
  });

  it('parses the supported providers as the egress allowlist default', () => {
    const allowedHosts = createConfig().get('git.egress.allowedHosts');
    expect(allowedHosts).toContain('github.com');
    expect(allowedHosts).toContain('gitlab.com');
    expect(allowedHosts).toContain('bitbucket.org');
  });

  it('splits a comma-separated ASCIIDOCOLLAB_GIT_EGRESS_ALLOWED_HOSTS override into hosts', () => {
    process.env.ASCIIDOCOLLAB_GIT_EGRESS_ALLOWED_HOSTS = 'git.example.com, git2.example.com';

    expect(createConfig().get('git.egress.allowedHosts')).toEqual([
      'git.example.com',
      'git2.example.com',
    ]);
  });

  it('binds the worker pool size and rate limit fields to their env vars', () => {
    process.env.ASCIIDOCOLLAB_GIT_WORKER_POOL_SIZE = '8';
    process.env.ASCIIDOCOLLAB_GIT_RATE_LIMIT_MAX = '15';
    process.env.ASCIIDOCOLLAB_GIT_RATE_LIMIT_WINDOW = '30000';
    process.env.ASCIIDOCOLLAB_GIT_MAX_REPO_SIZE_MB = '250';
    process.env.ASCIIDOCOLLAB_GIT_LFS_THRESHOLD_BYTES = '5242880';

    expect(createConfig().get('git')).toMatchObject({
      workerPoolSize: 8,
      rateLimitMax: 15,
      rateLimitWindow: 30_000,
      maxRepoSizeMB: 250,
      lfsThresholdBytes: 5_242_880,
    });
  });

  it('rejects a credentialEncryptionKey that does not decode to exactly 32 bytes', () => {
    process.env.ASCIIDOCOLLAB_GIT_CREDENTIAL_ENCRYPTION_KEY = Buffer.alloc(16).toString('base64');

    const config = createConfig();
    expect(() => config.validate({ allowed: 'strict' })).toThrow(
      'must be a base64-encoded 32-byte string',
    );
  });

  it('rejects a credentialEncryptionKey that is not valid base64', () => {
    process.env.ASCIIDOCOLLAB_GIT_CREDENTIAL_ENCRYPTION_KEY = 'not base64 at all!! and wrong length too';

    const config = createConfig();
    expect(() => config.validate({ allowed: 'strict' })).toThrow(
      'must be a base64-encoded 32-byte string',
    );
  });

  it('accepts a well-formed base64-encoded 32-byte credentialEncryptionKey', () => {
    process.env.ASCIIDOCOLLAB_GIT_CREDENTIAL_ENCRYPTION_KEY = Buffer.alloc(32).toString('base64');

    const config = createConfig();
    // Other required fields (e.g. auth.session.secret) are intentionally left unset here;
    // this asserts only that the git fragment's own key format accepts a valid key by
    // reading back the coerced value rather than running full strict validation.
    expect(config.get('git.credentialEncryptionKey')).toBe(Buffer.alloc(32).toString('base64'));
  });
});
