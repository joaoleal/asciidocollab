import type { InjectOptions } from 'fastify';
import Fastify, { type FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import {
  ProjectId,
  FileNodeId,
  FileNode,
  FileNodeType,
  FilePath,
} from '@asciidocollab/domain';
import { projectRefactoringRoutes } from '../../../src/routes/projects/refactoring';
import { decorateApp } from '../../helpers/decorate-app';

jest.mock('../../../src/plugins/require-auth', () => ({
  requireAuth: jest.fn((_request: unknown, _rep: unknown, done: () => void) => done()),
  getAuthenticatedUserId: jest.fn(() => '550e8400-e29b-41d4-a716-446655440001'),
}));

const PROJECT_ID = '550e8400-e29b-41d4-a716-446655440002';
const ROOT_ID = '550e8400-e29b-41d4-a716-446655440003';
const BOOK_ID = '550e8400-e29b-41d4-a716-446655440004';
const CHAPTER_ID = '550e8400-e29b-41d4-a716-446655440005';

const BOOK = '[[intro]]\n== Intro\n\nSee <<intro>>.\n';
const CHAPTER = 'Back to <<intro,here>> and <<book.adoc#intro>>.\n';

function nodes(): FileNode[] {
  return [
    new FileNode(FileNodeId.create(ROOT_ID), ProjectId.create(PROJECT_ID), null, 'Root', FileNodeType.create('folder'), FilePath.create('/')),
    new FileNode(FileNodeId.create(BOOK_ID), ProjectId.create(PROJECT_ID), FileNodeId.create(ROOT_ID), 'book.adoc', FileNodeType.create('file'), FilePath.create('/book.adoc')),
    new FileNode(FileNodeId.create(CHAPTER_ID), ProjectId.create(PROJECT_ID), FileNodeId.create(ROOT_ID), 'chapter.adoc', FileNodeType.create('file'), FilePath.create('/chapter.adoc')),
  ];
}

interface ServerOptions {
  role?: string | null;
  rateLimitMax?: number;
  suggestionRateLimitMax?: number;
  store?: Map<string, string>;
}

async function buildServer(options: ServerOptions = {}): Promise<{ app: FastifyInstance; store: Map<string, string>; writes: jest.Mock }> {
  const { role = 'editor', rateLimitMax = 60, suggestionRateLimitMax = 600 } = options;
  const store = options.store ?? new Map<string, string>([['/book.adoc', BOOK], ['/chapter.adoc', CHAPTER]]);
  const writes = jest.fn(async (_p: unknown, path: { value: string }, content: Buffer) => {
    store.set(path.value, content.toString('utf8'));
  });
  const app = Fastify();
  await app.register(rateLimit, { global: false });
  decorateApp(app, 'config', {
    project: {
      refactoring: {
        rateLimitMax,
        rateLimitWindow: 60_000,
        suggestionRateLimitMax,
        suggestionRateLimitWindow: 60_000,
      },
    },
  });
  decorateApp(app, 'repos', {
    projectMember: {
      findByCompositeKey: jest.fn(async () => (role === null ? null : { role: { value: role } })),
    },
    fileNode: {
      findByProjectId: jest.fn(async () => nodes()),
    },
    auditLog: { save: jest.fn() },
  });
  decorateApp(app, 'stores', {
    fileStore: {
      read: jest.fn(async (_p: unknown, path: { value: string }) => {
        const content = store.get(path.value);
        return content === undefined ? null : Buffer.from(content, 'utf8');
      }),
      write: writes,
    },
  });
  await app.register(projectRefactoringRoutes);
  await app.ready();
  return { app, store, writes };
}

describe('GET /projects/:projectId/symbol-usages', () => {
  test('200 — lists the definition and every xref usage of an anchor across files', async () => {
    const { app } = await buildServer({ role: 'viewer' }); // membership is enough to read usages
    const response = await app.inject({ method: 'GET', url: `/projects/${PROJECT_ID}/symbol-usages?name=intro` });
    expect(response.statusCode).toBe(200);
    const { usages } = response.json().data;
    // The [[intro]] definition in book + <<intro>> in book + two in chapter.
    expect(usages).toHaveLength(4);
    const definitions = usages.filter((u: { kind: string }) => u.kind === 'definition');
    expect(definitions).toHaveLength(1);
    // The definition's kind survives the HTTP boundary (an explicit `[[intro]]` anchor), so the client
    // can tell it from a derived section id — the round-trip guard for the definitionKind field.
    expect(definitions[0].definitionKind).toBe('anchor');
    expect(usages.filter((u: { kind: string }) => u.kind === 'xref')).toHaveLength(3);
    await app.close();
  });

  test('403 — a non-member is forbidden', async () => {
    const { app } = await buildServer({ role: null });
    const response = await app.inject({ method: 'GET', url: `/projects/${PROJECT_ID}/symbol-usages?name=intro` });
    expect(response.statusCode).toBe(403);
    await app.close();
  });

  test('400 — missing name query parameter', async () => {
    const { app } = await buildServer();
    const response = await app.inject({ method: 'GET', url: `/projects/${PROJECT_ID}/symbol-usages` });
    expect(response.statusCode).toBe(400);
    await app.close();
  });

  test('kind=anchor excludes attribute usages that share the name', async () => {
    const store = new Map<string, string>([
      ['/book.adoc', '[[intro]]\n== Intro\n\n:intro: value\n'],
      ['/chapter.adoc', 'See <<intro>> and {intro}.\n'],
    ]);
    const { app } = await buildServer({ store });
    const response = await app.inject({ method: 'GET', url: `/projects/${PROJECT_ID}/symbol-usages?name=intro&kind=anchor` });
    expect(response.statusCode).toBe(200);
    const { usages } = response.json().data;
    expect(usages.map((u: { kind: string }) => u.kind).toSorted()).toEqual(['definition', 'xref']);
    await app.close();
  });

  test('kind=attribute returns only the attribute definition and {attr} usages', async () => {
    const store = new Map<string, string>([
      ['/book.adoc', '[[intro]]\n== Intro\n\n:intro: value\n'],
      ['/chapter.adoc', 'See <<intro>> and {intro}.\n'],
    ]);
    const { app } = await buildServer({ store });
    const response = await app.inject({ method: 'GET', url: `/projects/${PROJECT_ID}/symbol-usages?name=intro&kind=attribute` });
    expect(response.statusCode).toBe(200);
    const { usages } = response.json().data;
    expect(usages.map((u: { kind: string }) => u.kind).toSorted()).toEqual(['attributeRef', 'definition']);
    await app.close();
  });

  test('400 — invalid kind query parameter', async () => {
    const { app } = await buildServer();
    const response = await app.inject({ method: 'GET', url: `/projects/${PROJECT_ID}/symbol-usages?name=intro&kind=bogus` });
    expect(response.statusCode).toBe(400);
    await app.close();
  });

  test('429 — exceeding the detection (suggestion) rate-limit budget', async () => {
    const { app } = await buildServer({ suggestionRateLimitMax: 1 });
    const first = await app.inject({ method: 'GET', url: `/projects/${PROJECT_ID}/symbol-usages?name=intro` });
    expect(first.statusCode).toBe(200);
    const second = await app.inject({ method: 'GET', url: `/projects/${PROJECT_ID}/symbol-usages?name=intro` });
    expect(second.statusCode).toBe(429);
    await app.close();
  });

  test('detection budget is independent of the apply (rename) budget', async () => {
    // A tiny apply budget must NOT throttle the read-only detection path.
    const { app } = await buildServer({ rateLimitMax: 1, suggestionRateLimitMax: 5 });
    for (let index = 0; index < 3; index++) {
      const response = await app.inject({ method: 'GET', url: `/projects/${PROJECT_ID}/symbol-usages?name=intro` });
      expect(response.statusCode).toBe(200);
    }
    await app.close();
  });
});

function rename(app: FastifyInstance, body: InjectOptions['payload']) {
  return app.inject({ method: 'POST', url: `/projects/${PROJECT_ID}/symbol-rename`, payload: body });
}

describe('POST /projects/:projectId/symbol-rename', () => {
  test('200 — an editor renames an anchor and references across files', async () => {
    const { app, store } = await buildServer({ role: 'editor' });
    const response = await rename(app, { symbolKind: 'anchor', oldName: 'intro', newName: 'overview' });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.rewrittenFiles).toBe(2);
    expect(store.get('/book.adoc')).toContain('[[overview]]');
    expect(store.get('/chapter.adoc')).toContain('<<book.adoc#overview>>');
    await app.close();
  });

  test('403 — a viewer is forbidden and nothing is written', async () => {
    const { app, writes } = await buildServer({ role: 'viewer' });
    const response = await rename(app, { symbolKind: 'anchor', oldName: 'intro', newName: 'overview' });
    expect(response.statusCode).toBe(403);
    expect(writes).not.toHaveBeenCalled();
    await app.close();
  });

  test('400 — an invalid new name surfaces the ValidationError', async () => {
    const { app } = await buildServer({ role: 'editor' });
    const response = await rename(app, { symbolKind: 'anchor', oldName: 'intro', newName: '1 bad' });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('INVALID_SYMBOL_RENAME');
    await app.close();
  });

  test('400 — an unknown symbolKind is rejected by schema', async () => {
    const { app } = await buildServer({ role: 'editor' });
    const response = await rename(app, { symbolKind: 'section', oldName: 'intro', newName: 'overview' });
    expect(response.statusCode).toBe(400);
    await app.close();
  });

  test('429 — exceeding the per-route rate limit', async () => {
    const { app } = await buildServer({ role: 'editor', rateLimitMax: 1 });
    const first = await rename(app, { symbolKind: 'anchor', oldName: 'intro', newName: 'overview' });
    expect(first.statusCode).toBe(200);
    const second = await rename(app, { symbolKind: 'anchor', oldName: 'overview', newName: 'intro' });
    expect(second.statusCode).toBe(429);
    await app.close();
  });
});
