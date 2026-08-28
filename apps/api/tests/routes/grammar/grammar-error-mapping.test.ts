import Fastify, { type FastifyInstance } from 'fastify';

// Exercises the grammar routes' fallback mappings for a domain error that is neither a permission
// denial nor a not-found. The real use cases never return one, so they are replaced here with a
// stub that fails with a ValidationError — proving the fallbacks answer 400/500 rather than leaking.
jest.mock('@asciidocollab/domain', () => {
  const actual = jest.requireActual('@asciidocollab/domain');
  class FailingUseCase {
    async execute() {
      return { success: false, error: new actual.ValidationError('unexpected') };
    }
  }
  return {
    ...actual,
    AddDictionaryTermUseCase: FailingUseCase,
    RemoveDictionaryTermUseCase: FailingUseCase,
    ReplaceIgnoredLintsUseCase: FailingUseCase,
  };
});

jest.mock('../../../src/plugins/require-auth', () => ({
  requireAuth: jest.fn((_request: unknown, _rep: unknown, done: () => void) => done()),
  getAuthenticatedUserId: jest.fn(() => '550e8400-e29b-41d4-a716-446655440001'),
}));

import { dictionaryRoutes } from '../../../src/routes/grammar/dictionary';
import { ignoredLintsRoutes } from '../../../src/routes/grammar/ignored-lints';
import { decorateApp } from '../../helpers/decorate-app';

const PROJECT_ID = '550e8400-e29b-41d4-a716-446655440002';
const TERM_ID = '550e8400-e29b-41d4-a716-446655440003';
const DOCUMENT_ID = '550e8400-e29b-41d4-a716-446655440004';

async function buildServer(): Promise<FastifyInstance> {
  const app = Fastify();
  decorateApp(app, 'repos', {
    projectDictionary: {
      listByProject: jest.fn(async () => []),
      findByTerm: jest.fn(async () => null),
      add: jest.fn(),
      removeById: jest.fn(async () => true),
    },
    ignoredLint: {
      findByUserAndDocument: jest.fn(async () => null),
      upsert: jest.fn(),
    },
    fileNode: { findById: jest.fn(async () => ({ projectId: { value: PROJECT_ID } })) },
    projectMember: { findByCompositeKey: jest.fn(async () => ({ role: { value: 'editor' } })) },
    auditLog: { save: jest.fn() },
  });
  await app.register(dictionaryRoutes);
  await app.register(ignoredLintsRoutes);
  await app.ready();
  return app;
}

describe('grammar routes — unexpected error mapping', () => {
  it('answers 400 when adding a term fails for a reason other than permission', async () => {
    const app = await buildServer();

    const response = await app.inject({
      method: 'POST',
      url: `/api/projects/${PROJECT_ID}/dictionary`,
      payload: { term: 'Kubernetes' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('ValidationFailed');
    await app.close();
  });

  it('answers 500 when removing a term fails for an unexpected reason', async () => {
    const app = await buildServer();

    const response = await app.inject({
      method: 'DELETE',
      url: `/api/projects/${PROJECT_ID}/dictionary/${TERM_ID}`,
    });

    expect(response.statusCode).toBe(500);
    expect(response.json().error.code).toBe('INTERNAL_ERROR');
    await app.close();
  });

  it('answers 500 when replacing the ignored-lints blob fails for an unexpected reason', async () => {
    const app = await buildServer();

    const response = await app.inject({
      method: 'PUT',
      url: `/api/documents/${DOCUMENT_ID}/ignored-lints`,
      payload: { ignoredLintsJson: '["hash-a"]' },
    });

    expect(response.statusCode).toBe(500);
    expect(response.json().error.code).toBe('INTERNAL_ERROR');
    await app.close();
  });
});
