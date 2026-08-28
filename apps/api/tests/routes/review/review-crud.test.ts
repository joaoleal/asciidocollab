jest.mock('../../../src/plugins/require-auth', () => ({
  requireAuth: jest.fn((_request: unknown, _rep: unknown, done: () => void) => done()),
  getAuthenticatedUserId: jest.fn(() => '550e8400-e29b-41d4-a716-446655440001'),
}));

import {
  buildServer,
  emitMock,
  comment,
  reply,
  reaction,
  ACTOR_ID,
  DOCUMENT_ID,
  ITEM_ID,
  FILE_NODE_ID,
  FILE_NODE_NAME,
  PROJECT_ID,
  documentItemsUrl as documentItemsUrl,
  itemUrl,
  projectItemsUrl,
} from './harness';

const validAnchor = { quote: { exact: 'selected passage' }, lineHint: 3 };

describe('review CRUD happy paths', () => {
  describe('POST create root item', () => {
    test('201 — returns the item DTO and emits review-items-changed', async () => {
      const app = await buildServer();
      const response = await app.inject({
        method: 'POST',
        url: documentItemsUrl,
        payload: { kind: 'comment', body: 'looks good', anchor: validAnchor },
      });
      expect(response.statusCode).toBe(201);
      const dto = response.json().data;
      expect(dto.kind).toBe('comment');
      expect(dto.documentId).toBe(DOCUMENT_ID);
      expect(dto.projectId).toBe(PROJECT_ID);
      expect(dto.author).toEqual({ id: ACTOR_ID, displayName: 'Ada', avatarKey: 'initial-face:5' });
      expect(emitMock(app)).toHaveBeenCalledWith(PROJECT_ID, {
        type: 'review-items-changed',
        documentId: DOCUMENT_ID,
      });
      await app.close();
    });

    test('400 VALIDATION_ERROR — an empty body is rejected by the schema', async () => {
      const app = await buildServer();
      const response = await app.inject({
        method: 'POST',
        url: documentItemsUrl,
        payload: { kind: 'comment', body: '', anchor: validAnchor },
      });
      expect(response.statusCode).toBe(400);
      await app.close();
    });

    test('201 — round-trips a base64 relative position on the anchor', async () => {
      const relativePos = Buffer.from([1, 2, 3, 4]).toString('base64');
      const app = await buildServer();
      const response = await app.inject({
        method: 'POST',
        url: documentItemsUrl,
        payload: { kind: 'comment', body: 'anchored', anchor: { ...validAnchor, relPos: relativePos } },
      });
      expect(response.statusCode).toBe(201);
      expect(response.json().data.anchor.relPos).toBe(relativePos);
      await app.close();
    });

    test('persists the item through reviewComment.create', async () => {
      const create = jest.fn(async () => undefined);
      const app = await buildServer({ reviewComment: { create } });
      await app.inject({
        method: 'POST',
        url: documentItemsUrl,
        payload: { kind: 'task', body: 'do this', anchor: validAnchor },
      });
      expect(create).toHaveBeenCalledTimes(1);
      await app.close();
    });
  });

  describe('GET list a document', () => {
    test('200 — groups items into threads', async () => {
      const app = await buildServer({
        reviewComment: { listByDocument: jest.fn(async () => [comment(), reply()]) },
      });
      const response = await app.inject({ method: 'GET', url: documentItemsUrl });
      expect(response.statusCode).toBe(200);
      const { threads } = response.json().data;
      expect(threads).toHaveLength(1);
      expect(threads[0].root.id).toBe(ITEM_ID);
      expect(threads[0].replies).toHaveLength(1);
      await app.close();
    });

    test('200 — an empty document yields no threads', async () => {
      const app = await buildServer();
      const response = await app.inject({ method: 'GET', url: documentItemsUrl });
      expect(response.statusCode).toBe(200);
      expect(response.json().data.threads).toEqual([]);
      await app.close();
    });

    test('403 FORBIDDEN — a non-member cannot read a document’s threads', async () => {
      const app = await buildServer({ role: null });
      const response = await app.inject({ method: 'GET', url: documentItemsUrl });
      expect(response.statusCode).toBe(403);
      expect(response.json().error.code).toBe('FORBIDDEN');
      await app.close();
    });
  });

  describe('POST reply', () => {
    test('201 — appends a reply and emits', async () => {
      const app = await buildServer({
        reviewComment: {
          findById: jest.fn(async () => comment()),
          create: jest.fn(async () => undefined),
        },
      });
      const response = await app.inject({
        method: 'POST',
        url: `${itemUrl()}/replies`,
        payload: { body: 'agreed' },
      });
      expect(response.statusCode).toBe(201);
      expect(response.json().data.parentId).toBe(ITEM_ID);
      expect(emitMock(app)).toHaveBeenCalledWith(PROJECT_ID, {
        type: 'review-items-changed',
        documentId: DOCUMENT_ID,
      });
      await app.close();
    });
  });

  describe('POST resolve', () => {
    test('200 — resolves a comment thread', async () => {
      const app = await buildServer();
      const response = await app.inject({ method: 'POST', url: `${itemUrl()}/resolve` });
      expect(response.statusCode).toBe(200);
      expect(response.json().data.id).toBe(ITEM_ID);
      expect(response.json().data.resolvedAt).toBeDefined();
      await app.close();
    });
  });

  describe('POST reactions', () => {
    test('200 — an allowlisted emoji toggles and returns summaries', async () => {
      const app = await buildServer({
        reviewReaction: {
          toggle: jest.fn(async () => undefined),
          listForItems: jest.fn(async () => [reaction('👍')]),
        },
      });
      const response = await app.inject({
        method: 'POST',
        url: `${itemUrl()}/reactions`,
        payload: { emoji: '👍' },
      });
      expect(response.statusCode).toBe(200);
      const { reactions } = response.json().data;
      expect(reactions).toEqual([
        { emoji: '👍', count: 1, reactedByMe: true, userIds: [ACTOR_ID] },
      ]);
      await app.close();
    });

    test('200 — an item deleted between the toggle and the lookup skips the change event', async () => {
      let itemGone = false;
      const app = await buildServer({
        reviewComment: { findById: jest.fn(async () => (itemGone ? null : comment())) },
        reviewReaction: {
          toggle: jest.fn(async () => {
            itemGone = true;
          }),
          listForItems: jest.fn(async () => [reaction('👍')]),
        },
      });
      const response = await app.inject({
        method: 'POST',
        url: `${itemUrl()}/reactions`,
        payload: { emoji: '👍' },
      });
      expect(response.statusCode).toBe(200);
      expect(emitMock(app)).not.toHaveBeenCalled();
      await app.close();
    });

    test('400 VALIDATION_ERROR — a non-allowlisted emoji is rejected', async () => {
      const app = await buildServer();
      const response = await app.inject({
        method: 'POST',
        url: `${itemUrl()}/reactions`,
        payload: { emoji: '🦄' },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe('VALIDATION_ERROR');
      await app.close();
    });
  });

  describe('POST reanchor', () => {
    test('200 — reattaches a located anchor', async () => {
      const app = await buildServer();
      const response = await app.inject({
        method: 'POST',
        url: `${itemUrl()}/reanchor`,
        payload: { anchor: { quote: { exact: 'new passage' } } },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().data.anchor.state).toBe('located');
      await app.close();
    });
  });

  describe('GET list a project', () => {
    test('200 — returns a flat item list', async () => {
      const app = await buildServer({
        reviewComment: { listByProject: jest.fn(async () => [comment()]) },
      });
      const response = await app.inject({ method: 'GET', url: projectItemsUrl });
      expect(response.statusCode).toBe(200);
      const { items } = response.json().data;
      expect(items).toHaveLength(1);
      expect(items[0].id).toBe(ITEM_ID);
      await app.close();
    });

    test('200 — each item carries its backing file (id + name) for cross-document navigation', async () => {
      const app = await buildServer({
        reviewComment: { listByProject: jest.fn(async () => [comment()]) },
      });
      const response = await app.inject({ method: 'GET', url: projectItemsUrl });
      expect(response.statusCode).toBe(200);
      const { items } = response.json().data;
      expect(items[0].fileNodeId).toBe(FILE_NODE_ID);
      expect(items[0].fileName).toBe(FILE_NODE_NAME);
      await app.close();
    });

    test('200 — an item whose document no longer resolves simply omits the file fields', async () => {
      const app = await buildServer({
        reviewComment: { listByProject: jest.fn(async () => [comment()]) },
        document: { findById: jest.fn(async () => null) },
      });
      const response = await app.inject({ method: 'GET', url: projectItemsUrl });
      expect(response.statusCode).toBe(200);
      const { items } = response.json().data;
      expect(items[0].fileNodeId).toBeUndefined();
      expect(items[0].fileName).toBeUndefined();
      await app.close();
    });

    test('200 — an item whose file node no longer resolves omits the file fields', async () => {
      const app = await buildServer({
        reviewComment: { listByProject: jest.fn(async () => [comment()]) },
        fileNode: { findById: jest.fn(async () => null) },
      });
      const response = await app.inject({ method: 'GET', url: projectItemsUrl });
      expect(response.statusCode).toBe(200);
      const { items } = response.json().data;
      expect(items[0].fileNodeId).toBeUndefined();
      expect(items[0].fileName).toBeUndefined();
      await app.close();
    });

    test('200 — a known status filter is forwarded to the use case', async () => {
      const listByProject = jest.fn(async () => []);
      const app = await buildServer({ reviewComment: { listByProject } });
      const response = await app.inject({
        method: 'GET',
        url: `${projectItemsUrl}?status=open&assigneeId=${ACTOR_ID}`,
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().data.items).toEqual([]);
      expect(listByProject).toHaveBeenCalled();
      await app.close();
    });

    test('403 FORBIDDEN — a non-member cannot list a project’s items', async () => {
      const app = await buildServer({ role: null });
      const response = await app.inject({ method: 'GET', url: projectItemsUrl });
      expect(response.statusCode).toBe(403);
      expect(response.json().error.code).toBe('FORBIDDEN');
      await app.close();
    });

    test('400 VALIDATION_ERROR — an unknown status filter is rejected', async () => {
      const app = await buildServer();
      const response = await app.inject({
        method: 'GET',
        url: `${projectItemsUrl}?status=bogus`,
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe('VALIDATION_ERROR');
      await app.close();
    });
  });
});
