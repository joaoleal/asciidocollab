import Fastify, { type FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { SessionEncryption } from '@asciidocollab/infrastructure';
import { gitOAuthStartRoutes } from '../../../../src/routes/projects/git/oauth-start';
import { errorHandler } from '../../../../src/plugins/error-handler';
import { readOAuthState } from '../../../../src/lib/git-oauth-state';

jest.mock('../../../../src/plugins/require-auth', () => ({
  requireAuth: jest.fn((_request: unknown, _reply: unknown, done: () => void) => done()),
  getAuthenticatedUserId: jest.fn(() => ACTOR_ID),
}));

const ACTOR_ID = '550e8400-e29b-41d4-a716-446655440001';
const PROJECT_ID = '550e8400-e29b-41d4-a716-446655440002';
const STATE_KEY = Buffer.alloc(32, 3).toString('base64');

const CONFIGURED_GITHUB = {
  clientId: 'gh-client-id',
  clientSecret: 'gh-client-secret',
  redirectUri: 'https://app.example.com/api/git/oauth/github/callback',
  scopes: 'repo',
  authorizeUrl: 'https://github.com/login/oauth/authorize',
  tokenUrl: 'https://github.com/login/oauth/access_token',
};

const UNCONFIGURED_PROVIDER = {
  clientId: '',
  clientSecret: '',
  redirectUri: '',
  scopes: '',
  authorizeUrl: 'https://example.com/authorize',
  tokenUrl: 'https://example.com/token',
};

interface HarnessOptions {
  /** The caller's role on `PROJECT_ID`, or null for "not a member". */
  role?: string | null;
  /** github/gitlab/bitbucket provider config overrides — defaults to only github configured. */
  oauth?: {
    github?: typeof CONFIGURED_GITHUB;
    gitlab?: typeof UNCONFIGURED_PROVIDER;
    bitbucket?: typeof UNCONFIGURED_PROVIDER;
  };
}

function buildHarness(options: HarnessOptions = {}) {
  const { role = 'owner' } = options;
  const stateEncryption = new SessionEncryption({ encryptionKey: STATE_KEY });

  const app = Fastify();
  app.setErrorHandler(errorHandler);

  const build = async (): Promise<FastifyInstance> => {
    await app.register(rateLimit, { global: false });
    app.decorate('config', {
      git: {
        rateLimitMax: 20,
        rateLimitWindow: 60_000,
        oauth: {
          stateEncryptionKey: STATE_KEY,
          github: options.oauth?.github ?? CONFIGURED_GITHUB,
          gitlab: options.oauth?.gitlab ?? UNCONFIGURED_PROVIDER,
          bitbucket: options.oauth?.bitbucket ?? UNCONFIGURED_PROVIDER,
        },
      },
    } as never);
    app.decorate('repos', {
      projectMember: {
        findByCompositeKey: jest.fn(async () => (role === null ? null : { role: { value: role } })),
      },
      auditLog: { save: jest.fn() },
    } as never);
    app.decorate('services', { gitOAuthStateEncryption: stateEncryption } as never);
    await app.register(gitOAuthStartRoutes);
    await app.ready();
    return app;
  };

  return { build, stateEncryption };
}

function startOAuth(
  app: FastifyInstance,
  provider: string,
  payload: Record<string, unknown> = { remoteUrl: 'https://github.com/acme/handbook.git' },
) {
  return app.inject({ method: 'POST', url: `/api/projects/${PROJECT_ID}/git/oauth/${provider}/start`, payload });
}

describe('POST /api/projects/:projectId/git/oauth/:provider/start', () => {
  it('returns 200 with an authorizeUrl built from the configured provider, carrying a decryptable state', async () => {
    const { build, stateEncryption } = buildHarness();
    const app = await build();

    const response = await startOAuth(app, 'github', {
      remoteUrl: 'https://github.com/acme/handbook.git',
      branch: 'develop',
    });

    expect(response.statusCode).toBe(200);
    const { authorizeUrl } = response.json();
    const url = new URL(authorizeUrl);
    expect(url.origin + url.pathname).toBe('https://github.com/login/oauth/authorize');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe('gh-client-id');
    expect(url.searchParams.get('redirect_uri')).toBe('https://app.example.com/api/git/oauth/github/callback');
    expect(url.searchParams.get('scope')).toBe('repo');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toBeTruthy();

    const state = url.searchParams.get('state');
    expect(state).toBeTruthy();
    const decoded = readOAuthState(stateEncryption, state as string);
    expect(decoded.success).toBe(true);
    if (decoded.success) {
      expect(decoded.value).toMatchObject({
        projectId: PROJECT_ID,
        actorId: ACTOR_ID,
        provider: 'github',
        remoteUrl: 'https://github.com/acme/handbook.git',
        branch: 'develop',
      });
      expect(decoded.value.codeVerifier.length).toBeGreaterThanOrEqual(43);
    }

    await app.close();
  });

  it('omits branch from the state when none was given', async () => {
    const { build, stateEncryption } = buildHarness();
    const app = await build();

    const response = await startOAuth(app, 'github');
    const url = new URL(response.json().authorizeUrl);
    const decoded = readOAuthState(stateEncryption, url.searchParams.get('state') as string);

    expect(decoded.success).toBe(true);
    if (decoded.success) expect(decoded.value.branch).toBeUndefined();

    await app.close();
  });

  it('answers 403 for a non-owner (editor) and mints no state', async () => {
    const { build } = buildHarness({ role: 'editor' });
    const app = await build();

    const response = await startOAuth(app, 'github');

    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('insufficient_role');

    await app.close();
  });

  it('answers 403 for a non-member and mints no state', async () => {
    const { build } = buildHarness({ role: null });
    const app = await build();

    const response = await startOAuth(app, 'github');

    expect(response.statusCode).toBe(403);

    await app.close();
  });

  it('answers 404 oauth_not_configured for a provider with no clientId', async () => {
    const { build } = buildHarness();
    const app = await build();

    const response = await startOAuth(app, 'gitlab');

    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('oauth_not_configured');

    await app.close();
  });

  it('answers 400 for an unrecognized provider', async () => {
    const { build } = buildHarness();
    const app = await build();

    const response = await startOAuth(app, 'not-a-real-provider');

    expect(response.statusCode).toBe(400);

    await app.close();
  });

  it('answers 400 for an invalid remote URL', async () => {
    const { build } = buildHarness();
    const app = await build();

    const response = await startOAuth(app, 'github', { remoteUrl: 'not a valid url; rm -rf /' });

    expect(response.statusCode).toBe(400);

    await app.close();
  });

  it('answers 400 when remoteUrl is missing', async () => {
    const { build } = buildHarness();
    const app = await build();

    const response = await startOAuth(app, 'github', {});

    expect(response.statusCode).toBe(400);

    await app.close();
  });

  it('never leaks the client secret in the response', async () => {
    const { build } = buildHarness();
    const app = await build();

    const response = await startOAuth(app, 'github');

    expect(JSON.stringify(response.json())).not.toContain(CONFIGURED_GITHUB.clientSecret);

    await app.close();
  });
});
