import Fastify from 'fastify';
import {
  GetOpenRegistrationUseCase,
  SetOpenRegistrationUseCase,
  GetMaxUploadSizeUseCase,
  SetMaxUploadSizeUseCase,
  PermissionDeniedError,
} from '@asciidocollab/domain';
import { adminSettingsRoute } from '../../../src/routes/admin/settings';
import { decorateApp } from '../../helpers/decorate-app';

jest.mock('../../../src/plugins/require-auth', () => ({
  requireAuth: jest.fn((_request: unknown, _rep: unknown, done: () => void) => done()),
  getAuthenticatedUserId: jest.fn(() => '550e8400-e29b-41d4-a716-446655440001'),
}));

jest.mock('../../../src/plugins/require-admin', () => ({
  requireAdmin: jest.fn((_request: unknown, _rep: unknown, done: () => void) => done()),
}));


function buildTestServer() {
  const app = Fastify();
  decorateApp(app, 'repos', {
    systemSetting: { get: jest.fn(), set: jest.fn() },
    user: { findById: jest.fn() },
    auditLog: { save: jest.fn() },
  });
  decorateApp(app, 'config', {
    storage: { maxUploadSizeBytes: 10_485_760 },
    admin: { invite: { rateLimitMax: 100, rateLimitWindow: 60_000 } },
  });
  app.register(adminSettingsRoute);
  return app;
}

describe('GET /admin/settings', () => {
  it('returns current settings with 200', async () => {
    jest.spyOn(GetOpenRegistrationUseCase.prototype, 'execute').mockResolvedValue({ enabled: true });
    jest.spyOn(GetMaxUploadSizeUseCase.prototype, 'execute').mockResolvedValue({ maxUploadSizeBytes: 10_485_760 });

    const app = buildTestServer();
    const response = await app.inject({ method: 'GET', url: '/admin/settings' });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.openRegistration).toBe(true);
    expect(body.maxUploadSizeBytes).toBe(10_485_760);
  });
});

describe('PATCH /admin/settings', () => {
  it('updates openRegistration and returns 200', async () => {
    jest.spyOn(SetOpenRegistrationUseCase.prototype, 'execute').mockResolvedValue({ success: true, value: undefined });
    jest.spyOn(GetOpenRegistrationUseCase.prototype, 'execute').mockResolvedValue({ enabled: true });
    jest.spyOn(GetMaxUploadSizeUseCase.prototype, 'execute').mockResolvedValue({ maxUploadSizeBytes: 10_485_760 });

    const app = buildTestServer();
    const response = await app.inject({
      method: 'PATCH',
      url: '/admin/settings',
      payload: { openRegistration: true },
    });

    expect(response.statusCode).toBe(200);
  });

  it('returns 403 when SetOpenRegistrationUseCase fails', async () => {
    jest.spyOn(SetOpenRegistrationUseCase.prototype, 'execute').mockResolvedValue({
      success: false,
      error: new PermissionDeniedError(),
    });

    const app = buildTestServer();
    const response = await app.inject({
      method: 'PATCH',
      url: '/admin/settings',
      payload: { openRegistration: false },
    });

    expect(response.statusCode).toBe(403);
    expect(JSON.parse(response.body).error.code).toBe('PERMISSION_DENIED');
  });

  it('updates maxUploadSizeBytes and returns 200', async () => {
    jest.spyOn(SetMaxUploadSizeUseCase.prototype, 'execute').mockResolvedValue({ success: true, value: undefined });
    jest.spyOn(GetOpenRegistrationUseCase.prototype, 'execute').mockResolvedValue({ enabled: false });
    jest.spyOn(GetMaxUploadSizeUseCase.prototype, 'execute').mockResolvedValue({ maxUploadSizeBytes: 5_242_880 });

    const app = buildTestServer();
    const response = await app.inject({
      method: 'PATCH',
      url: '/admin/settings',
      payload: { maxUploadSizeBytes: 5_242_880 },
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body).maxUploadSizeBytes).toBe(5_242_880);
  });

  it('returns 403 when SetMaxUploadSizeUseCase fails', async () => {
    jest.spyOn(SetMaxUploadSizeUseCase.prototype, 'execute').mockResolvedValue({
      success: false,
      error: new PermissionDeniedError(),
    });

    const app = buildTestServer();
    const response = await app.inject({
      method: 'PATCH',
      url: '/admin/settings',
      payload: { maxUploadSizeBytes: 1024 },
    });

    expect(response.statusCode).toBe(403);
  });
});
