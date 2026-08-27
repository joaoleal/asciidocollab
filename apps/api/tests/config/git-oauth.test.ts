import { createConfig } from '../../src/config/schema';
import { assertGitOAuthConfigConsistent, isGitOAuthProviderConfigured } from '../../src/config/schema-git';
import type { GitConfig } from '../../src/config/schema-git';
import { setupTestEnvironment } from '../helpers/test-environment';

/** A freshly built config's `git` fragment, reflecting whatever env vars are currently set. */
function baseGit() {
  return createConfig().get('git');
}

/**
 * The guided OAuth authorization-code + PKCE connect flow's config surface: a dedicated state
 * encryption key plus one config fragment per provider (github/gitlab/bitbucket), every field
 * optional/empty by default so a fresh install has OAuth entirely unavailable until an operator
 * registers a provider's OAuth app.
 */
describe('git oauth config', () => {
  const gitOAuthEnvironmentKeys = [
    'ASCIIDOCOLLAB_GIT_OAUTH_STATE_ENCRYPTION_KEY',
    'ASCIIDOCOLLAB_GIT_OAUTH_GITHUB_CLIENT_ID',
    'ASCIIDOCOLLAB_GIT_OAUTH_GITHUB_CLIENT_SECRET',
    'ASCIIDOCOLLAB_GIT_OAUTH_GITHUB_REDIRECT_URI',
    'ASCIIDOCOLLAB_GIT_OAUTH_GITHUB_SCOPES',
    'ASCIIDOCOLLAB_GIT_OAUTH_GITHUB_AUTHORIZE_URL',
    'ASCIIDOCOLLAB_GIT_OAUTH_GITHUB_TOKEN_URL',
    'ASCIIDOCOLLAB_GIT_OAUTH_GITLAB_CLIENT_ID',
    'ASCIIDOCOLLAB_GIT_OAUTH_GITLAB_CLIENT_SECRET',
    'ASCIIDOCOLLAB_GIT_OAUTH_GITLAB_REDIRECT_URI',
    'ASCIIDOCOLLAB_GIT_OAUTH_GITLAB_SCOPES',
    'ASCIIDOCOLLAB_GIT_OAUTH_GITLAB_AUTHORIZE_URL',
    'ASCIIDOCOLLAB_GIT_OAUTH_GITLAB_TOKEN_URL',
    'ASCIIDOCOLLAB_GIT_OAUTH_BITBUCKET_CLIENT_ID',
    'ASCIIDOCOLLAB_GIT_OAUTH_BITBUCKET_CLIENT_SECRET',
    'ASCIIDOCOLLAB_GIT_OAUTH_BITBUCKET_REDIRECT_URI',
    'ASCIIDOCOLLAB_GIT_OAUTH_BITBUCKET_SCOPES',
    'ASCIIDOCOLLAB_GIT_OAUTH_BITBUCKET_AUTHORIZE_URL',
    'ASCIIDOCOLLAB_GIT_OAUTH_BITBUCKET_TOKEN_URL',
  ] as const;

  const saved: Record<string, string | undefined> = {};

  beforeAll(() => {
    // So `config.validate({ allowed: 'strict' })` below reflects only this fragment's own fields —
    // every OTHER required field (session secret, email from, …) already has a valid value.
    setupTestEnvironment();
  });

  beforeEach(() => {
    for (const key of gitOAuthEnvironmentKeys) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of gitOAuthEnvironmentKeys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it('loads with every field optional/empty and the documented per-provider defaults', () => {
    expect(createConfig().get('git.oauth')).toEqual({
      stateEncryptionKey: '',
      github: {
        clientId: '',
        clientSecret: '',
        redirectUri: '',
        scopes: 'repo',
        authorizeUrl: 'https://github.com/login/oauth/authorize',
        tokenUrl: 'https://github.com/login/oauth/access_token',
      },
      gitlab: {
        clientId: '',
        clientSecret: '',
        redirectUri: '',
        scopes: 'read_repository write_repository',
        authorizeUrl: 'https://gitlab.com/oauth/authorize',
        tokenUrl: 'https://gitlab.com/oauth/token',
      },
      bitbucket: {
        clientId: '',
        clientSecret: '',
        redirectUri: '',
        scopes: 'repository repository:write',
        authorizeUrl: 'https://bitbucket.org/site/oauth2/authorize',
        tokenUrl: 'https://bitbucket.org/site/oauth2/access_token',
      },
    });
  });

  it('validates cleanly with every OAuth field left at its default (OAuth fully unconfigured)', () => {
    // git.credentialEncryptionKey is unconditionally required (its own format never allows empty) —
    // set it here purely so this assertion isolates the OAuth fragment's own validation behavior.
    process.env.ASCIIDOCOLLAB_GIT_CREDENTIAL_ENCRYPTION_KEY = Buffer.alloc(32).toString('base64');
    const config = createConfig();
    expect(() => config.validate({ allowed: 'strict' })).not.toThrow();
    delete process.env.ASCIIDOCOLLAB_GIT_CREDENTIAL_ENCRYPTION_KEY;
  });

  it('binds each provider field to its own env var', () => {
    process.env.ASCIIDOCOLLAB_GIT_OAUTH_GITHUB_CLIENT_ID = 'gh-client-id';
    process.env.ASCIIDOCOLLAB_GIT_OAUTH_GITHUB_CLIENT_SECRET = 'gh-client-secret';
    process.env.ASCIIDOCOLLAB_GIT_OAUTH_GITHUB_REDIRECT_URI = 'https://app.example.com/api/git/oauth/github/callback';
    process.env.ASCIIDOCOLLAB_GIT_OAUTH_GITHUB_SCOPES = 'repo read:org';
    process.env.ASCIIDOCOLLAB_GIT_OAUTH_GITHUB_AUTHORIZE_URL = 'https://ghe.example.com/login/oauth/authorize';
    process.env.ASCIIDOCOLLAB_GIT_OAUTH_GITHUB_TOKEN_URL = 'https://ghe.example.com/login/oauth/access_token';

    expect(createConfig().get('git.oauth.github')).toEqual({
      clientId: 'gh-client-id',
      clientSecret: 'gh-client-secret',
      redirectUri: 'https://app.example.com/api/git/oauth/github/callback',
      scopes: 'repo read:org',
      authorizeUrl: 'https://ghe.example.com/login/oauth/authorize',
      tokenUrl: 'https://ghe.example.com/login/oauth/access_token',
    });
  });

  it('rejects a stateEncryptionKey that does not decode to exactly 32 bytes, when non-empty', () => {
    process.env.ASCIIDOCOLLAB_GIT_OAUTH_STATE_ENCRYPTION_KEY = Buffer.alloc(16).toString('base64');
    const config = createConfig();
    expect(() => config.validate({ allowed: 'strict' })).toThrow(
      'must be a base64-encoded 32-byte string',
    );
  });

  it('rejects a stateEncryptionKey that is not valid base64, when non-empty', () => {
    process.env.ASCIIDOCOLLAB_GIT_OAUTH_STATE_ENCRYPTION_KEY = 'not base64 at all!! and wrong length too';
    const config = createConfig();
    expect(() => config.validate({ allowed: 'strict' })).toThrow(
      'must be a base64-encoded 32-byte string',
    );
  });

  it('accepts an empty stateEncryptionKey (OAuth entirely unconfigured)', () => {
    process.env.ASCIIDOCOLLAB_GIT_CREDENTIAL_ENCRYPTION_KEY = Buffer.alloc(32).toString('base64');
    const config = createConfig();
    expect(() => config.validate({ allowed: 'strict' })).not.toThrow();
    delete process.env.ASCIIDOCOLLAB_GIT_CREDENTIAL_ENCRYPTION_KEY;
    expect(config.get('git.oauth.stateEncryptionKey')).toBe('');
  });

  it('accepts a well-formed 32-byte stateEncryptionKey', () => {
    process.env.ASCIIDOCOLLAB_GIT_OAUTH_STATE_ENCRYPTION_KEY = Buffer.alloc(32).toString('base64');
    expect(createConfig().get('git.oauth.stateEncryptionKey')).toBe(Buffer.alloc(32).toString('base64'));
  });

  describe('isGitOAuthProviderConfigured', () => {
    it('is true only when clientId is non-empty', () => {
      const configured = createConfig();
      expect(isGitOAuthProviderConfigured(configured.get('git.oauth.github'))).toBe(false);

      process.env.ASCIIDOCOLLAB_GIT_OAUTH_GITHUB_CLIENT_ID = 'gh-client-id';
      expect(isGitOAuthProviderConfigured(createConfig().get('git.oauth.github'))).toBe(true);
    });
  });

  describe('assertGitOAuthConfigConsistent', () => {
    it('does not throw when no provider is configured, even with an empty stateEncryptionKey', () => {
      expect(() => assertGitOAuthConfigConsistent(baseGit())).not.toThrow();
    });

    it('does not throw when a provider is configured AND stateEncryptionKey is set', () => {
      const git: GitConfig = {
        ...baseGit(),
        oauth: {
          ...baseGit().oauth,
          stateEncryptionKey: Buffer.alloc(32).toString('base64'),
          github: { ...baseGit().oauth.github, clientId: 'gh-client-id' },
        },
      };
      expect(() => assertGitOAuthConfigConsistent(git)).not.toThrow();
    });

    it('throws when a provider is configured but stateEncryptionKey is empty', () => {
      const git: GitConfig = {
        ...baseGit(),
        oauth: {
          ...baseGit().oauth,
          stateEncryptionKey: '',
          gitlab: { ...baseGit().oauth.gitlab, clientId: 'gl-client-id' },
        },
      };
      expect(() => assertGitOAuthConfigConsistent(git)).toThrow(
        'ASCIIDOCOLLAB_GIT_OAUTH_STATE_ENCRYPTION_KEY is required',
      );
    });
  });
});
