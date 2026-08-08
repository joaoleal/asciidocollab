import Fastify, { type FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';

// Exercises the route's defensive 500 mapping for an UNEXPECTED domain error (one that is neither
// PermissionDenied nor ValidationError). The real use cases never return such an error, so the use
// cases are mocked here to return a ProjectNotFoundError — proving the fallback maps to a 500 and
// does not leak the error to the client.
jest.mock('@asciidocollab/domain', () => {
  const actual = jest.requireActual('@asciidocollab/domain');
  class FailingUseCase {
    async execute() {
      return { success: false, error: new actual.ProjectNotFoundError('p') };
    }
  }
  return { ...actual, FindReferencesUseCase: FailingUseCase, RenameSymbolUseCase: FailingUseCase };
});

jest.mock('../../../src/plugins/require-auth', () => ({
  requireAuth: jest.fn((_request: unknown, _rep: unknown, done: () => void) => done()),
  getAuthenticatedUserId: jest.fn(() => '550e8400-e29b-41d4-a716-446655440001'),
}));

import { projectRefactoringRoutes } from '../../../src/routes/projects/refactoring';
import { decorateApp } from '../../helpers/decorate-app';

const PROJECT_ID = '550e8400-e29b-41d4-a716-446655440002';

async function buildServer(): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(rateLimit, { global: false });
  decorateApp(app, 'config', { project: { refactoring: { rateLimitMax: 60, rateLimitWindow: 60_000 } } });
  decorateApp(app, 'repos', {
    projectMember: { findByCompositeKey: jest.fn(async () => ({ role: { value: 'editor' } })) },
    fileNode: { findByProjectId: jest.fn(async () => []) },
    auditLog: { save: jest.fn() },
  });
  decorateApp(app, 'stores', { fileStore: { read: jest.fn(async () => null), write: jest.fn() } });
  await app.register(projectRefactoringRoutes);
  await app.ready();
  return app;
}

describe('refactoring routes — unexpected error mapping', () => {
  test('500 — find-usages maps an unexpected domain error to INTERNAL_ERROR', async () => {
    const app = await buildServer();
    const response = await app.inject({ method: 'GET', url: `/projects/${PROJECT_ID}/symbol-usages?name=intro` });
    expect(response.statusCode).toBe(500);
    expect(response.json().error.code).toBe('INTERNAL_ERROR');
    await app.close();
  });

  test('500 — rename maps an unexpected domain error to INTERNAL_ERROR', async () => {
    const app = await buildServer();
    const response = await app.inject({
      method: 'POST',
      url: `/projects/${PROJECT_ID}/symbol-rename`,
      payload: { symbolKind: 'anchor', oldName: 'a', newName: 'b' },
    });
    expect(response.statusCode).toBe(500);
    expect(response.json().error.code).toBe('INTERNAL_ERROR');
    await app.close();
  });
});
