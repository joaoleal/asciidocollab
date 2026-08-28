jest.mock('../../../src/plugins/require-auth', () => ({
  requireAuth: jest.fn((_request: unknown, _rep: unknown, done: () => void) => done()),
  getAuthenticatedUserId: jest.fn(() => '550e8400-e29b-41d4-a716-446655440001'),
}));

import {
  buildServer,
  emitMock,
  comment,
  DOCUMENT_ID,
  PROJECT_ID,
  itemUrl,
  documentBulkDeleteUrl as documentBulkDeleteUrl,
  projectBulkDeleteUrl,
} from './harness';

describe('review deletion paths', () => {
  describe('DELETE a single item', () => {
    test('200 — deletes the item and emits for its document', async () => {
      const del = jest.fn(async () => undefined);
      const app = await buildServer({
        reviewComment: { findById: jest.fn(async () => comment()), delete: del },
      });
      const response = await app.inject({ method: 'DELETE', url: itemUrl() });
      expect(response.statusCode).toBe(200);
      expect(response.json().data).toEqual({ deleted: true });
      expect(del).toHaveBeenCalledTimes(1);
      expect(emitMock(app)).toHaveBeenCalledWith(PROJECT_ID, {
        type: 'review-items-changed',
        documentId: DOCUMENT_ID,
      });
      await app.close();
    });

    test('200 — an item already gone leaves no document to broadcast for', async () => {
      // The route captures the document before deleting; a lookup that misses there — but resolves
      // for the use case — is the concurrent-delete race the change event has to sit out.
      let firstLookupDone = false;
      const findById = jest.fn(async () => {
        if (firstLookupDone) return comment();
        firstLookupDone = true;
        return null;
      });
      const app = await buildServer({
        reviewComment: { findById, delete: jest.fn(async () => undefined) },
      });
      const response = await app.inject({ method: 'DELETE', url: itemUrl() });
      expect(response.statusCode).toBe(200);
      expect(emitMock(app)).not.toHaveBeenCalled();
      await app.close();
    });
  });

  describe('POST document bulk-delete', () => {
    test('200 — clears the document and reports the count', async () => {
      const app = await buildServer({
        reviewComment: { deleteByDocument: jest.fn(async () => 4) },
      });
      const response = await app.inject({
        method: 'POST',
        url: documentBulkDeleteUrl,
        payload: { confirm: true },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().data).toEqual({ deleted: 4 });
      expect(emitMock(app)).toHaveBeenCalledWith(PROJECT_ID, {
        type: 'review-items-changed',
        documentId: DOCUMENT_ID,
      });
      await app.close();
    });

    test('200 — a matching expectedCount passes the optimistic guard', async () => {
      const app = await buildServer({
        reviewComment: {
          countByDocument: jest.fn(async () => 3),
          deleteByDocument: jest.fn(async () => 3),
        },
      });
      const response = await app.inject({
        method: 'POST',
        url: documentBulkDeleteUrl,
        payload: { confirm: true, expectedCount: 3 },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().data).toEqual({ deleted: 3 });
      await app.close();
    });

    test('409 COUNT_CONFLICT — an expectedCount mismatch is rejected', async () => {
      const deleteByDocument = jest.fn(async () => 5);
      const app = await buildServer({
        reviewComment: { countByDocument: jest.fn(async () => 5), deleteByDocument },
      });
      const response = await app.inject({
        method: 'POST',
        url: documentBulkDeleteUrl,
        payload: { confirm: true, expectedCount: 2 },
      });
      expect(response.statusCode).toBe(409);
      expect(response.json().error.code).toBe('COUNT_CONFLICT');
      expect(deleteByDocument).not.toHaveBeenCalled();
      await app.close();
    });

    test('400 — confirm:false fails the const schema', async () => {
      const app = await buildServer();
      const response = await app.inject({
        method: 'POST',
        url: documentBulkDeleteUrl,
        payload: { confirm: false },
      });
      expect(response.statusCode).toBe(400);
      await app.close();
    });
  });

  describe('POST project bulk-delete', () => {
    test('200 — an owner clears the whole project', async () => {
      const app = await buildServer({
        role: 'owner',
        reviewComment: { deleteByProject: jest.fn(async () => 9) },
      });
      const response = await app.inject({
        method: 'POST',
        url: projectBulkDeleteUrl,
        payload: { confirm: true },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().data).toEqual({ deleted: 9 });
      // A project-wide clear emits the broadcast (null document) signal so every client refetches.
      expect(emitMock(app)).toHaveBeenCalledWith(PROJECT_ID, {
        type: 'review-items-changed',
        documentId: null,
      });
      await app.close();
    });

    test('409 COUNT_CONFLICT — an owner with a mismatched expectedCount', async () => {
      const app = await buildServer({
        role: 'owner',
        reviewComment: {
          countByProject: jest.fn(async () => 7),
          deleteByProject: jest.fn(async () => 7),
        },
      });
      const response = await app.inject({
        method: 'POST',
        url: projectBulkDeleteUrl,
        payload: { confirm: true, expectedCount: 1 },
      });
      expect(response.statusCode).toBe(409);
      expect(response.json().error.code).toBe('COUNT_CONFLICT');
      await app.close();
    });
  });
});
