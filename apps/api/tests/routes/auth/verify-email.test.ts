import Fastify from 'fastify';
import { verifyEmailRoute } from '../../../src/routes/auth/verify-email';
import { decorateApp } from '../../helpers/decorate-app';

const USER_ID = '550e8400-e29b-41d4-a716-446655440001';
const OTHER_USER_ID = '550e8400-e29b-41d4-a716-446655440099';

const DEFAULT_CONFIG = {
  auth: {
    emailVerification: { rateLimitMax: 100, rateLimitWindow: 60_000 },
  },
};

type Session = {
  userId?: string;
  emailVerified?: boolean;
};

type BuildOptions = {
  useCaseResult?: { success: boolean; value?: unknown; error?: Error };
  sessionUserId?: string;
};

function buildTestServer(options: BuildOptions = {}) {
  const app = Fastify();

  const sessionState: Session = {
    userId: options.sessionUserId,
  };

  app.addHook('preHandler', async (request) => {
    (request as unknown as { session: Session }).session = sessionState;
  });

  const defaultUseCaseResult = {
    success: true,
    value: { userId: { value: USER_ID } },
  };

  const useCaseResult = options.useCaseResult ?? defaultUseCaseResult;

  jest.spyOn(
    require('@asciidocollab/domain'),
    'VerifyEmailUseCase',
  ).mockImplementation(() => ({
    execute: jest.fn().mockResolvedValue(useCaseResult),
  }));

  decorateApp(app, 'repos', {
    user: {
      save: jest.fn().mockResolvedValue(undefined),
    },
    emailVerificationToken: {
      findByTokenHash: jest.fn().mockResolvedValue(null),
    },
    auditLog: {
      save: jest.fn().mockResolvedValue(undefined),
    },
  });

  decorateApp(app, 'services', {
    tokenGenerator: {
      hashToken: jest.fn().mockReturnValue('hashed-token'),
    },
  });

  decorateApp(app, 'config', DEFAULT_CONFIG);

  app.register(verifyEmailRoute);
  return { app, sessionState };
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('GET /auth/verify-email', () => {
  test('returns 400 INVALID_TOKEN when token query param is missing', async () => {
    const { app } = buildTestServer();
    const response = await app.inject({
      method: 'GET',
      url: '/auth/verify-email',
    });
    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.body);
    expect(body.error.code).toBe('INVALID_TOKEN');
    expect(typeof body.error.message).toBe('string');
  });

  test('returns 200 with { message: "Email verified" } when token is valid', async () => {
    const { app } = buildTestServer();
    const response = await app.inject({
      method: 'GET',
      url: '/auth/verify-email?token=valid-token',
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.message).toBe('Email verified');
  });

  test('returns 400 INVALID_TOKEN when use case fails', async () => {
    const { app } = buildTestServer({
      useCaseResult: { success: false, error: new Error('Token expired or invalid') },
    });
    const response = await app.inject({
      method: 'GET',
      url: '/auth/verify-email?token=bad-token',
    });
    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.body);
    expect(body.error.code).toBe('INVALID_TOKEN');
  });

  test('upgrades session emailVerified when session userId matches verified userId', async () => {
    const { app, sessionState } = buildTestServer({ sessionUserId: USER_ID });
    await app.inject({
      method: 'GET',
      url: '/auth/verify-email?token=valid-token',
    });
    expect(sessionState.emailVerified).toBe(true);
  });

  test('does NOT upgrade session when session userId differs from verified userId', async () => {
    const { app, sessionState } = buildTestServer({ sessionUserId: OTHER_USER_ID });
    await app.inject({
      method: 'GET',
      url: '/auth/verify-email?token=valid-token',
    });
    expect(sessionState.emailVerified).toBeUndefined();
  });

  test('does NOT upgrade session when no userId is present in session', async () => {
    const { app, sessionState } = buildTestServer({ sessionUserId: undefined });
    await app.inject({
      method: 'GET',
      url: '/auth/verify-email?token=valid-token',
    });
    expect(sessionState.emailVerified).toBeUndefined();
  });
});
