import Fastify from 'fastify';
import { User, UserId, Email, Timestamps } from '@asciidocollab/domain';
import { profileUpdateRoute } from '../../../../src/routes/auth/me/profile';
import { decorateApp } from '../../../helpers/decorate-app';

jest.mock('../../../../src/plugins/require-auth', () => ({
  requireAuth: jest.fn((_request: unknown, _rep: unknown, done: () => void) => done()),
  getAuthenticatedUserId: jest.fn(() => '550e8400-e29b-41d4-a716-446655440001'),
}));

const USER_ID = '550e8400-e29b-41d4-a716-446655440001';

function makeUser(overrides: { avatarKey?: string | null; appTheme?: string } = {}): User {
  return new User(
    UserId.create(USER_ID),
    Email.create('test@example.com'),
    'Original Name',
    'password-hash',
    [],
    null,
    null,
    false,
    new Timestamps(),
    true,
    'SELF_REGISTERED',
    overrides.avatarKey ?? null,
    overrides.appTheme ?? 'system',
  );
}

function buildTestServer() {
  const app = Fastify();
  let currentUser = makeUser();

  decorateApp(app, 'repos', {
    user: {
      findById: jest.fn().mockImplementation(() => currentUser),
      save: jest.fn().mockImplementation((user: User) => { currentUser = user; }),
    },
  });

  decorateApp(app, 'config', {
    auth: { profileUpdate: { rateLimitMax: 100, rateLimitWindow: 60_000 } },
  });

  app.register(profileUpdateRoute);
  return { app, getUser: () => currentUser };
}

describe('PATCH /auth/me/profile', () => {
  test('updates displayName successfully', async () => {
    const { app } = buildTestServer();
    const response = await app.inject({
      method: 'PATCH',
      url: '/auth/me/profile',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ displayName: 'New Name' }),
    });
    expect(response.statusCode).toBe(200);
  });

  test('accepts valid appTheme "light"', async () => {
    const { app } = buildTestServer();
    const response = await app.inject({
      method: 'PATCH',
      url: '/auth/me/profile',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ appTheme: 'light' }),
    });
    expect(response.statusCode).toBe(200);
  });

  test('accepts valid appTheme "dark"', async () => {
    const { app } = buildTestServer();
    const response = await app.inject({
      method: 'PATCH',
      url: '/auth/me/profile',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ appTheme: 'dark' }),
    });
    expect(response.statusCode).toBe(200);
  });

  test('accepts valid appTheme "system"', async () => {
    const { app } = buildTestServer();
    const response = await app.inject({
      method: 'PATCH',
      url: '/auth/me/profile',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ appTheme: 'system' }),
    });
    expect(response.statusCode).toBe(200);
  });

  test('rejects invalid appTheme value', async () => {
    const { app } = buildTestServer();
    const response = await app.inject({
      method: 'PATCH',
      url: '/auth/me/profile',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ appTheme: 'blue' }),
    });
    expect(response.statusCode).toBe(400);
  });

  test('accepts avatarKey string value', async () => {
    const { app } = buildTestServer();
    const response = await app.inject({
      method: 'PATCH',
      url: '/auth/me/profile',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ avatarKey: 'bottts-neutral' }),
    });
    expect(response.statusCode).toBe(200);
  });

  test('accepts avatarKey null value', async () => {
    const { app } = buildTestServer();
    const response = await app.inject({
      method: 'PATCH',
      url: '/auth/me/profile',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ avatarKey: null }),
    });
    expect(response.statusCode).toBe(200);
  });

  test('rejects body with no recognized fields (empty object)', async () => {
    const { app } = buildTestServer();
    const response = await app.inject({
      method: 'PATCH',
      url: '/auth/me/profile',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(response.statusCode).toBe(400);
  });
});
