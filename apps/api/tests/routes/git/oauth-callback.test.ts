import Fastify, { type FastifyInstance } from 'fastify';
import { SessionEncryption } from '@asciidocollab/infrastructure';
import { GitWorkerTransportError } from '@asciidocollab/infrastructure';
import { gitOAuthCallbackRoutes } from '../../../src/routes/git/oauth-callback';
import { errorHandler } from '../../../src/plugins/error-handler';
import { mintOAuthState } from '../../../src/lib/git-oauth-state';
import * as gitOauth from '../../../src/lib/git-oauth';

jest.mock('../../../src/lib/git-oauth', () => ({
  ...jest.requireActual('../../../src/lib/git-oauth'),
  exchangeCodeForToken: jest.fn(),
}));

const mockExchangeCodeForToken = gitOauth.exchangeCodeForToken as jest.MockedFunction<
  typeof gitOauth.exchangeCodeForToken
>;

jest.mock('../../../src/plugins/require-auth', () => ({
  requireAuth: jest.fn((_request: unknown, _reply: unknown, done: () => void) => done()),
  getAuthenticatedUserId: jest.fn(() => ACTOR_ID),
}));

const ACTOR_ID = '550e8400-e29b-41d4-a716-446655440001';
const FOREIGN_ACTOR_ID = '550e8400-e29b-41d4-a716-446655440099';
const PROJECT_ID = '550e8400-e29b-41d4-a716-446655440002';
const STATE_KEY = Buffer.alloc(32, 5).toString('base64');
const ACCESS_TOKEN = 'gho_the-super-secret-access-token';
const CLIENT_SECRET = 'gh-client-secret-value';
const CODE_VERIFIER = 'the-code-verifier-value';
const AUTH_CODE = 'the-authorization-code';
const FRONTEND_URL = 'https://app.example.com';

const stateEncryption = new SessionEncryption({ encryptionKey: STATE_KEY });

const GITHUB_CONFIG = {
  clientId: 'gh-client-id',
  clientSecret: CLIENT_SECRET,
  redirectUri: 'https://app.example.com/api/git/oauth/github/callback',
  scopes: 'repo',
  authorizeUrl: 'https://github.com/login/oauth/authorize',
  tokenUrl: 'https://github.com/login/oauth/access_token',
};

function mintValidState(overrides: Partial<Parameters<typeof mintOAuthState>[1]> = {}, now?: number) {
  return mintOAuthState(
    stateEncryption,
    {
      projectId: PROJECT_ID,
      actorId: ACTOR_ID,
      provider: 'github',
      remoteUrl: 'https://github.com/acme/handbook.git',
      codeVerifier: CODE_VERIFIER,
      ...overrides,
    },
    now,
  );
}

interface HarnessOptions {
  connectResult?: unknown;
  connectError?: Error;
  githubConfig?: typeof GITHUB_CONFIG;
  /** When given, every `request.log.warn(...)` call's arguments are pushed here. */
  captureWarnCalls?: unknown[][];
}

function buildHarness(options: HarnessOptions = {}) {
  const {
    connectResult = { ok: true, data: { repository: { id: 'repo-1' } } },
    connectError,
    githubConfig = GITHUB_CONFIG,
    captureWarnCalls,
  } = options;

  const connect = jest.fn(async (_input: unknown) => {
    if (connectError) throw connectError;
    return connectResult;
  });

  const app = Fastify();
  app.setErrorHandler(errorHandler);
  app.decorate('config', {
    api: { frontendUrl: FRONTEND_URL },
    git: {
      oauth: {
        stateEncryptionKey: STATE_KEY,
        github: githubConfig,
        gitlab: { clientId: '', clientSecret: '', redirectUri: '', scopes: '', authorizeUrl: '', tokenUrl: '' },
        bitbucket: { clientId: '', clientSecret: '', redirectUri: '', scopes: '', authorizeUrl: '', tokenUrl: '' },
      },
    },
  } as never);
  app.decorate('services', { gitOAuthStateEncryption: stateEncryption } as never);
  app.decorate('stores', { gitWorkerClient: { connect } } as never);

  if (captureWarnCalls) {
    app.addHook('onRequest', (request, _reply, done) => {
      const log = request.log as unknown as { warn: (...arguments_: unknown[]) => void };
      const originalWarn = log.warn.bind(log);
      log.warn = (...arguments_: unknown[]) => {
        captureWarnCalls.push(arguments_);
        originalWarn(...arguments_);
      };
      done();
    });
  }

  const build = async (): Promise<FastifyInstance> => {
    await app.register(gitOAuthCallbackRoutes);
    await app.ready();
    return app;
  };

  return { build, connect };
}

function callback(app: FastifyInstance, provider: string, query: Record<string, string>) {
  const search = new URLSearchParams(query).toString();
  return app.inject({ method: 'GET', url: `/api/git/oauth/${provider}/callback?${search}` });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockExchangeCodeForToken.mockResolvedValue({ success: true, value: { accessToken: ACCESS_TOKEN } });
});

describe('GET /api/git/oauth/:provider/callback', () => {
  it('on success: exchanges the code, calls connect with the token and the state values, and redirects to the success indicator', async () => {
    const { build, connect } = buildHarness();
    const app = await build();
    const state = mintValidState({ branch: 'develop' });

    const response = await callback(app, 'github', { code: AUTH_CODE, state });

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe(
      `${FRONTEND_URL}/dashboard/projects/${PROJECT_ID}/settings?gitOAuth=connected`,
    );
    expect(mockExchangeCodeForToken).toHaveBeenCalledWith({
      tokenUrl: GITHUB_CONFIG.tokenUrl,
      code: AUTH_CODE,
      codeVerifier: CODE_VERIFIER,
      clientId: GITHUB_CONFIG.clientId,
      clientSecret: GITHUB_CONFIG.clientSecret,
      redirectUri: GITHUB_CONFIG.redirectUri,
    });
    expect(connect).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      actorId: ACTOR_ID,
      provider: 'github',
      remoteUrl: 'https://github.com/acme/handbook.git',
      token: ACCESS_TOKEN,
      branch: 'develop',
    });

    await app.close();
  });

  it('omits branch from the connect call when the state carried none', async () => {
    const { build, connect } = buildHarness();
    const app = await build();
    const state = mintValidState();

    await callback(app, 'github', { code: AUTH_CODE, state });

    const calledWith = connect.mock.calls[0][0];
    expect(Object.prototype.hasOwnProperty.call(calledWith, 'branch')).toBe(false);

    await app.close();
  });

  it('redirects to a generic failure page, and never calls connect, when code is missing', async () => {
    const { build, connect } = buildHarness();
    const app = await build();
    const state = mintValidState();

    const response = await callback(app, 'github', { state });

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe(`${FRONTEND_URL}/dashboard?gitOAuthError=1`);
    expect(connect).not.toHaveBeenCalled();
    expect(mockExchangeCodeForToken).not.toHaveBeenCalled();

    await app.close();
  });

  it('redirects to a generic failure page when state is missing', async () => {
    const { build, connect } = buildHarness();
    const app = await build();

    const response = await callback(app, 'github', { code: AUTH_CODE });

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe(`${FRONTEND_URL}/dashboard?gitOAuthError=1`);
    expect(connect).not.toHaveBeenCalled();

    await app.close();
  });

  it('redirects to a generic failure page when the provider reports an error instead of a code', async () => {
    const { build, connect } = buildHarness();
    const app = await build();
    const state = mintValidState();

    const response = await callback(app, 'github', { state, error: 'access_denied' });

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe(`${FRONTEND_URL}/dashboard?gitOAuthError=1`);
    expect(connect).not.toHaveBeenCalled();

    await app.close();
  });

  it('redirects to a generic failure page for an unrecognized provider path segment', async () => {
    const { build, connect } = buildHarness();
    const app = await build();
    const state = mintValidState();

    const response = await callback(app, 'not-a-real-provider', { code: AUTH_CODE, state });

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe(`${FRONTEND_URL}/dashboard?gitOAuthError=1`);
    expect(connect).not.toHaveBeenCalled();

    await app.close();
  });

  it('redirects to a generic failure page for a tampered state, and never calls connect', async () => {
    const { build, connect } = buildHarness();
    const app = await build();
    const state = mintValidState();
    const tampered = state.slice(0, -2) + (state.slice(-2) === 'aa' ? 'bb' : 'aa');

    const response = await callback(app, 'github', { code: AUTH_CODE, state: tampered });

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe(`${FRONTEND_URL}/dashboard?gitOAuthError=1`);
    expect(connect).not.toHaveBeenCalled();
    expect(mockExchangeCodeForToken).not.toHaveBeenCalled();

    await app.close();
  });

  it('redirects to a generic failure page for an expired state, and never calls connect', async () => {
    const { build, connect } = buildHarness();
    const app = await build();
    const longAgo = Date.now() - 60 * 60 * 1000;
    const state = mintValidState({}, longAgo);

    const response = await callback(app, 'github', { code: AUTH_CODE, state });

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe(`${FRONTEND_URL}/dashboard?gitOAuthError=1`);
    expect(connect).not.toHaveBeenCalled();

    await app.close();
  });

  it('redirects to the project failure page for a foreign actor (CSRF mismatch), and never calls connect or exchanges the code', async () => {
    const { build, connect } = buildHarness();
    const app = await build();
    // Minted by/for ACTOR_ID, but the authenticated caller in this test's mocked require-auth is
    // also ACTOR_ID — so mint it for a DIFFERENT actor to simulate the mismatch instead.
    const state = mintValidState({ actorId: FOREIGN_ACTOR_ID });

    const response = await callback(app, 'github', { code: AUTH_CODE, state });

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe(
      `${FRONTEND_URL}/dashboard/projects/${PROJECT_ID}/settings?gitOAuth=failed`,
    );
    expect(connect).not.toHaveBeenCalled();
    expect(mockExchangeCodeForToken).not.toHaveBeenCalled();

    await app.close();
  });

  it('redirects to the project failure page when the state names a different provider than the URL', async () => {
    const { build, connect } = buildHarness();
    const app = await build();
    const state = mintValidState({ provider: 'gitlab' });

    const response = await callback(app, 'github', { code: AUTH_CODE, state });

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe(
      `${FRONTEND_URL}/dashboard/projects/${PROJECT_ID}/settings?gitOAuth=failed`,
    );
    expect(connect).not.toHaveBeenCalled();

    await app.close();
  });

  it('redirects to the project failure page when the code exchange fails, and never calls connect', async () => {
    mockExchangeCodeForToken.mockResolvedValue({ success: false, error: { name: 'OAuthExchangeError', reason: 'provider_rejected' } });
    const { build, connect } = buildHarness();
    const app = await build();
    const state = mintValidState();

    const response = await callback(app, 'github', { code: AUTH_CODE, state });

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe(
      `${FRONTEND_URL}/dashboard/projects/${PROJECT_ID}/settings?gitOAuth=failed`,
    );
    expect(connect).not.toHaveBeenCalled();

    await app.close();
  });

  it('redirects to the project failure page when the git-worker connect refuses (e.g. already connected)', async () => {
    const { build, connect } = buildHarness({ connectResult: { ok: false, error: 'RepositoryAlreadyConnectedError' } });
    const app = await build();
    const state = mintValidState();

    const response = await callback(app, 'github', { code: AUTH_CODE, state });

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe(
      `${FRONTEND_URL}/dashboard/projects/${PROJECT_ID}/settings?gitOAuth=failed`,
    );
    expect(connect).toHaveBeenCalled();

    await app.close();
  });

  it('redirects to the project failure page when the git-worker is unreachable', async () => {
    const { build } = buildHarness({ connectError: new GitWorkerTransportError('boom') });
    const app = await build();
    const state = mintValidState();

    const response = await callback(app, 'github', { code: AUTH_CODE, state });

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe(
      `${FRONTEND_URL}/dashboard/projects/${PROJECT_ID}/settings?gitOAuth=failed`,
    );

    await app.close();
  });

  it('redirects to the project failure page when the provider was unconfigured by the time the callback lands', async () => {
    const { build, connect } = buildHarness({
      githubConfig: { ...GITHUB_CONFIG, clientId: '' },
    });
    const app = await build();
    const state = mintValidState();

    const response = await callback(app, 'github', { code: AUTH_CODE, state });

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe(
      `${FRONTEND_URL}/dashboard/projects/${PROJECT_ID}/settings?gitOAuth=failed`,
    );
    expect(connect).not.toHaveBeenCalled();
    expect(mockExchangeCodeForToken).not.toHaveBeenCalled();

    await app.close();
  });

  it('never leaks the access token, client secret, code, or code verifier into any logged line, on a failure path', async () => {
    mockExchangeCodeForToken.mockResolvedValue({ success: false, error: { name: 'OAuthExchangeError', reason: 'provider_rejected' } });
    const warnCalls: unknown[][] = [];
    const { build } = buildHarness({ captureWarnCalls: warnCalls });
    const app = await build();
    const state = mintValidState();

    await callback(app, 'github', { code: AUTH_CODE, state });

    const serialized = JSON.stringify(warnCalls);
    expect(serialized).not.toContain(ACCESS_TOKEN);
    expect(serialized).not.toContain(CLIENT_SECRET);
    expect(serialized).not.toContain(AUTH_CODE);
    expect(serialized).not.toContain(CODE_VERIFIER);

    await app.close();
  });

  it('never leaks the access token, client secret, code, or code verifier in the redirect response itself', async () => {
    const { build } = buildHarness();
    const app = await build();
    const state = mintValidState();

    const response = await callback(app, 'github', { code: AUTH_CODE, state });

    const serialized = `${response.headers.location}\n${response.payload}`;
    expect(serialized).not.toContain(ACCESS_TOKEN);
    expect(serialized).not.toContain(CLIENT_SECRET);
    expect(serialized).not.toContain(CODE_VERIFIER);

    await app.close();
  });
});
