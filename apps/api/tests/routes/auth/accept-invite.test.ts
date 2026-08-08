import Fastify from 'fastify';
import { acceptInviteRoute } from '../../../src/routes/auth/accept-invite';
import { InvalidTokenError, DuplicateEmailError } from '@asciidocollab/domain';
import { decorateApp } from '../../helpers/decorate-app';

const USER_ID = '550e8400-e29b-41d4-a716-446655440001';

const DEFAULT_CONFIG = {
  auth: {
    invitation: { rateLimitMax: 100, rateLimitWindow: 60_000 },
    password: {
      minLength: 8,
      requireUppercase: false,
      requireLowercase: false,
      requireDigits: false,
      requireSymbols: false,
    },
    session: {},
  },
};

type Session = {
  userId?: string;
  emailVerified?: boolean;
  isAdmin?: boolean;
};

type BuildOptions = {
  invitation?: unknown;
  useCaseResult?: { success: boolean; value?: unknown; error?: Error };
};

function buildTestServer(options: BuildOptions = {}) {
  const app = Fastify();

  // Track the session state mutations
  const sessionState: Session = {};

  app.addHook('preHandler', async (request) => {
    (request as unknown as { session: Session }).session = sessionState;
  });

  const validInvitation = {
    isValid: true,
    recipientEmail: { value: 'invitee@example.com' },
  };

  const defaultUseCaseResult = {
    success: true,
    value: { userId: { value: USER_ID } },
  };

  decorateApp(app, 'repos', {
    userInvitation: {
      findByTokenHash: jest.fn().mockResolvedValue(
        options.invitation === undefined ? validInvitation : options.invitation,
      ),
    },
    user: {
      save: jest.fn().mockResolvedValue(undefined),
      findByEmail: jest.fn().mockResolvedValue(null),
    },
    auditLog: {
      save: jest.fn().mockResolvedValue(undefined),
    },
  });

  decorateApp(app, 'services', {
    tokenGenerator: {
      hashToken: jest.fn().mockReturnValue('hashed-token'),
      generateInvitationToken: jest.fn(),
    },
    passwordHasher: {
      hash: jest.fn().mockResolvedValue('hashed-password'),
      verify: jest.fn().mockResolvedValue(true),
    },
    commonPasswordChecker: {
      isCommon: jest.fn().mockReturnValue(false),
    },
    breachChecker: {
      isBreached: jest.fn().mockResolvedValue(false),
    },
  });

  decorateApp(app, 'config', DEFAULT_CONFIG);

  // We mock AcceptUserInvitationUseCase to control result
  const useCaseResult = options.useCaseResult ?? defaultUseCaseResult;
  // The use case is instantiated inside the handler, so we mock the module
  jest.spyOn(
    require('@asciidocollab/domain'),
    'AcceptUserInvitationUseCase',
  ).mockImplementation(() => ({
    execute: jest.fn().mockResolvedValue(useCaseResult),
  }));

  app.register(acceptInviteRoute);
  return { app, sessionState };
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('GET /auth/accept-invite', () => {
  test('returns 200 with email when token is valid', async () => {
    const { app } = buildTestServer();
    const response = await app.inject({
      method: 'GET',
      url: '/auth/accept-invite?token=valid-token',
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body).toEqual({ email: 'invitee@example.com' });
  });

  test('returns 400 INVALID_TOKEN when token query param is missing', async () => {
    const { app } = buildTestServer();
    const response = await app.inject({
      method: 'GET',
      url: '/auth/accept-invite',
    });
    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.body);
    expect(body.error.code).toBe('INVALID_TOKEN');
  });

  test('returns 400 INVALID_TOKEN when invitation is not found', async () => {
    const { app } = buildTestServer({ invitation: null });
    const response = await app.inject({
      method: 'GET',
      url: '/auth/accept-invite?token=unknown-token',
    });
    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.body);
    expect(body.error.code).toBe('INVALID_TOKEN');
  });

  test('returns 400 INVALID_TOKEN when invitation is expired (isValid = false)', async () => {
    const { app } = buildTestServer({
      invitation: { isValid: false, recipientEmail: { value: 'invitee@example.com' } },
    });
    const response = await app.inject({
      method: 'GET',
      url: '/auth/accept-invite?token=expired-token',
    });
    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.body);
    expect(body.error.code).toBe('INVALID_TOKEN');
  });
});

describe('POST /auth/accept-invite', () => {
  test('returns 201 with success message on valid registration', async () => {
    const { app } = buildTestServer();
    const response = await app.inject({
      method: 'POST',
      url: '/auth/accept-invite',
      headers: { 'content-type': 'application/json' },
      payload: { token: 'valid-token', displayName: 'New User', password: 'MyP@ssw0rd' },
    });
    expect(response.statusCode).toBe(201);
    const body = JSON.parse(response.body);
    expect(body.message).toBe('Account created');
  });

  test('sets userId, emailVerified=true, isAdmin=false on the session after success', async () => {
    const { app, sessionState } = buildTestServer();
    await app.inject({
      method: 'POST',
      url: '/auth/accept-invite',
      headers: { 'content-type': 'application/json' },
      payload: { token: 'valid-token', displayName: 'New User', password: 'MyP@ssw0rd' },
    });
    expect(sessionState.userId).toBe(USER_ID);
    expect(sessionState.emailVerified).toBe(true);
    expect(sessionState.isAdmin).toBe(false);
  });

  test('returns 400 INVALID_TOKEN when use case returns InvalidTokenError', async () => {
    const { app } = buildTestServer({
      useCaseResult: { success: false, error: new InvalidTokenError('Token is invalid or expired') },
    });
    const response = await app.inject({
      method: 'POST',
      url: '/auth/accept-invite',
      headers: { 'content-type': 'application/json' },
      payload: { token: 'bad-token', displayName: 'User', password: 'pass' },
    });
    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.body);
    expect(body.error.code).toBe('INVALID_TOKEN');
  });

  test('returns 409 DUPLICATE_EMAIL when use case returns DuplicateEmailError', async () => {
    const { app } = buildTestServer({
      useCaseResult: { success: false, error: new DuplicateEmailError('invitee@example.com') },
    });
    const response = await app.inject({
      method: 'POST',
      url: '/auth/accept-invite',
      headers: { 'content-type': 'application/json' },
      payload: { token: 'valid-token', displayName: 'User', password: 'pass' },
    });
    expect(response.statusCode).toBe(409);
    const body = JSON.parse(response.body);
    expect(body.error.code).toBe('DUPLICATE_EMAIL');
  });

  test('returns 400 VALIDATION_ERROR for other use case errors', async () => {
    const genericError = new Error('Password too weak');
    // Plain Error has no .name === 'InvalidTokenError' or 'DuplicateEmailError'
    const { app } = buildTestServer({
      useCaseResult: { success: false, error: genericError },
    });
    const response = await app.inject({
      method: 'POST',
      url: '/auth/accept-invite',
      headers: { 'content-type': 'application/json' },
      payload: { token: 'valid-token', displayName: 'User', password: 'pass' },
    });
    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.body);
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  test('returns 400 when required body fields are missing', async () => {
    const { app } = buildTestServer();
    const response = await app.inject({
      method: 'POST',
      url: '/auth/accept-invite',
      headers: { 'content-type': 'application/json' },
      payload: { token: 'valid-token' },
    });
    expect(response.statusCode).toBe(400);
  });
});
