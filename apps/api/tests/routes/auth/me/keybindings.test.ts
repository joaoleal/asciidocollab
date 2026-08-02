import Fastify from 'fastify';
import { DEFAULT_KEY_BINDINGS, UpdateKeyBindingUseCase, ResetKeyBindingUseCase, ValidationError } from '@asciidocollab/domain';
import { keybindingsRoutes } from '../../../../src/routes/auth/me/keybindings';

// Mock requireAuth
jest.mock('../../../../src/plugins/require-auth', () => ({
  requireAuth: jest.fn((_request: unknown, _reply: unknown, done: () => void) => done()),
  getAuthenticatedUserId: jest.fn(() => '550e8400-e29b-41d4-a716-446655440001'),
}));

const userId = '550e8400-e29b-41d4-a716-446655440001';

const mockKeyBindingRepo = {
  findAll: jest.fn().mockResolvedValue([]),
  upsert: jest.fn().mockResolvedValue(undefined),
  delete: jest.fn().mockResolvedValue(undefined),
};

async function buildTestServer() {
  const app = Fastify();
  app.decorate('repos', { keyBinding: mockKeyBindingRepo } as never);
  app.decorate('config', {} as never);
  app.decorate('stores', {} as never);
  app.decorate('services', {} as never);
  app.decorate('prisma', null as never);
  await app.register(keybindingsRoutes);
  await app.ready();
  return app;
}

describe('Keybindings routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockKeyBindingRepo.findAll.mockResolvedValue([]);
  });

  it('GET returns every registered binding, defaulted, for a new user', async () => {
    const app = await buildTestServer();
    const response = await app.inject({ method: 'GET', url: '/auth/me/keybindings' });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as { action: string; isDefault: boolean }[];
    // Counted from the registry rather than written out as a number. This is what the settings page
    // lists, so a shortcut added to the registry has to appear here — and a test pinned to a literal
    // count fails on the addition itself, which says nothing about whether it is being served.
    expect(body.map((binding) => binding.action).toSorted()).toEqual(
      Object.keys(DEFAULT_KEY_BINDINGS).toSorted(),
    );
    expect(body.every((binding) => binding.isDefault)).toBe(true);
    await app.close();
  });

  it('GET serves the editor shortcuts alongside the file tree ones', async () => {
    // The settings page groups by namespace and offers whatever it is given. The editor's shortcuts
    // reaching it is the whole of what makes them configurable rather than merely hard-coded.
    const app = await buildTestServer();
    const response = await app.inject({ method: 'GET', url: '/auth/me/keybindings?namespace=editor' });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as { action: string; keyCombo: string }[];
    expect(body.length).toBeGreaterThan(0);
    expect(body.every((binding) => binding.action.startsWith('editor:'))).toBe(true);
    expect(body.find((binding) => binding.action === 'editor:bold')?.keyCombo).toBe('Mod+B');
    await app.close();
  });

  it('GET ?namespace=file-tree filters correctly', async () => {
    const app = await buildTestServer();
    const response = await app.inject({ method: 'GET', url: '/auth/me/keybindings?namespace=file-tree' });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.every((b: { action: string }) => b.action.startsWith('file-tree:'))).toBe(true);
    await app.close();
  });

  it('PATCH valid binding returns updated dto', async () => {
    const app = await buildTestServer();
    const response = await app.inject({
      method: 'PATCH',
      url: '/auth/me/keybindings/file-tree:rename',
      payload: { keyCombo: 'F3' },
    });
    expect(response.statusCode).toBe(200);
    await app.close();
  });

  it('PATCH reserved combo returns 400', async () => {
    const app = await buildTestServer();
    const response = await app.inject({
      method: 'PATCH',
      url: '/auth/me/keybindings/file-tree:rename',
      payload: { keyCombo: 'Ctrl+W' },
    });
    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it('PATCH unknown action returns 400', async () => {
    const app = await buildTestServer();
    const response = await app.inject({
      method: 'PATCH',
      url: '/auth/me/keybindings/unknown:action',
      payload: { keyCombo: 'F3' },
    });
    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it('PATCH duplicate within namespace returns 409', async () => {
    mockKeyBindingRepo.findAll.mockResolvedValue([{ userId, action: 'file-tree:delete', keyCombo: 'F3' }]);
    const app = await buildTestServer();
    const response = await app.inject({
      method: 'PATCH',
      url: '/auth/me/keybindings/file-tree:rename',
      payload: { keyCombo: 'F3' },
    });
    expect(response.statusCode).toBe(409);
    await app.close();
  });

  it('DELETE returns 204 and subsequent GET shows default', async () => {
    const app = await buildTestServer();
    const deleteResponse = await app.inject({ method: 'DELETE', url: '/auth/me/keybindings/file-tree:rename' });
    expect(deleteResponse.statusCode).toBe(204);
    await app.close();
  });
});

describe('Keybindings routes — error fallbacks', () => {
  afterEach(() => jest.restoreAllMocks());

  it('PATCH returns 500 for unexpected error', async () => {
    jest.spyOn(UpdateKeyBindingUseCase.prototype, 'execute').mockResolvedValue({
      success: false,
      error: Object.assign(new Error('unexpected'), { name: 'UnexpectedError' }) as never,
    });
    const app = await buildTestServer();
    const response = await app.inject({
      method: 'PATCH',
      url: '/auth/me/keybindings/file-tree:rename',
      payload: { keyCombo: 'F3' },
    });
    expect(response.statusCode).toBe(500);
    expect(JSON.parse(response.body).error.code).toBe('INTERNAL_ERROR');
    await app.close();
  });

  it('DELETE returns 400 VALIDATION_ERROR when use case fails with ValidationError', async () => {
    jest.spyOn(ResetKeyBindingUseCase.prototype, 'execute').mockResolvedValue({
      success: false,
      error: new ValidationError('invalid action') as never,
    });
    const app = await buildTestServer();
    const response = await app.inject({ method: 'DELETE', url: '/auth/me/keybindings/unknown:action' });
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body).error.code).toBe('VALIDATION_ERROR');
    await app.close();
  });

  it('DELETE returns 500 for unexpected error', async () => {
    jest.spyOn(ResetKeyBindingUseCase.prototype, 'execute').mockResolvedValue({
      success: false,
      error: Object.assign(new Error('unexpected'), { name: 'UnexpectedError' }) as never,
    });
    const app = await buildTestServer();
    const response = await app.inject({ method: 'DELETE', url: '/auth/me/keybindings/file-tree:rename' });
    expect(response.statusCode).toBe(500);
    expect(JSON.parse(response.body).error.code).toBe('INTERNAL_ERROR');
    await app.close();
  });
});
