import type { InjectOptions } from 'fastify';
jest.mock('../../../src/plugins/require-auth', () => ({
  requireAuth: jest.fn((_request: unknown, _rep: unknown, done: () => void) => done()),
  getAuthenticatedUserId: jest.fn(() => '550e8400-e29b-41d4-a716-446655440001'),
}));

import {
  ReviewComment,
  ReviewCommentId,
  ProjectId,
  DocumentId,
  UserId,
} from '@asciidocollab/domain';
import {
  buildServer,
  emitMock,
  comment,
  task,
  anchor,
  ASSIGNEE_ID,
  DOCUMENT_ID,
  ITEM_ID,
  PROJECT_ID,
  itemUrl,
} from './harness';

/** A root comment authored by someone OTHER than the acting user (for the author-only edit guard). */
function foreignComment(): ReviewComment {
  return new ReviewComment(
    ReviewCommentId.create(ITEM_ID),
    ProjectId.create(PROJECT_ID),
    DocumentId.create(DOCUMENT_ID),
    null,
    'comment',
    'someone else wrote this',
    UserId.create(ASSIGNEE_ID),
    null,
    null,
    null,
    null,
    null,
    anchor(),
  );
}

function patch(app: Awaited<ReturnType<typeof buildServer>>, body: InjectOptions['payload']) {
  return app.inject({ method: 'PATCH', url: itemUrl(), payload: body });
}

describe('PATCH a review item', () => {
  describe('op=edit', () => {
    test('200 — the author edits the body and the change is broadcast', async () => {
      const update = jest.fn(async () => undefined);
      const app = await buildServer({ reviewComment: { findById: jest.fn(async () => comment()), update } });
      const response = await patch(app, { op: 'edit', body: 'revised body' });
      expect(response.statusCode).toBe(200);
      expect(response.json().data.body).toBe('revised body');
      expect(update).toHaveBeenCalledTimes(1);
      expect(emitMock(app)).toHaveBeenCalledWith(PROJECT_ID, {
        type: 'review-items-changed',
        documentId: DOCUMENT_ID,
      });
      await app.close();
    });

    test('403 FORBIDDEN — a non-author editor cannot rewrite the body', async () => {
      const update = jest.fn(async () => undefined);
      const app = await buildServer({ reviewComment: { findById: jest.fn(async () => foreignComment()), update } });
      const response = await patch(app, { op: 'edit', body: 'hijacked' });
      expect(response.statusCode).toBe(403);
      expect(response.json().error.code).toBe('FORBIDDEN');
      expect(update).not.toHaveBeenCalled();
      await app.close();
    });

    test('400 VALIDATION_ERROR — edit without a body', async () => {
      const app = await buildServer();
      const response = await patch(app, { op: 'edit' });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe('VALIDATION_ERROR');
      await app.close();
    });
  });

  describe('op=convert', () => {
    test('200 — promotes a comment to a task', async () => {
      const app = await buildServer({ reviewComment: { findById: jest.fn(async () => comment()) } });
      const response = await patch(app, { op: 'convert', kind: 'task' });
      expect(response.statusCode).toBe(200);
      expect(response.json().data.kind).toBe('task');
      expect(response.json().data.status).toBe('open');
      expect(emitMock(app)).toHaveBeenCalledWith(PROJECT_ID, {
        type: 'review-items-changed',
        documentId: DOCUMENT_ID,
      });
      await app.close();
    });

    test('400 VALIDATION_ERROR — convert without a kind', async () => {
      const app = await buildServer();
      const response = await patch(app, { op: 'convert' });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe('VALIDATION_ERROR');
      await app.close();
    });
  });

  describe('op=assign', () => {
    test('200 — assigns a task to a user', async () => {
      const app = await buildServer({ reviewComment: { findById: jest.fn(async () => task()) } });
      const response = await patch(app, { op: 'assign', assigneeId: ASSIGNEE_ID, dueDate: '2026-08-01' });
      expect(response.statusCode).toBe(200);
      const dto = response.json().data;
      expect(dto.assignee).toEqual({ id: ASSIGNEE_ID, displayName: 'Ada', avatarKey: 'initial-face:5' });
      expect(dto.dueDate).toBe('2026-08-01');
      await app.close();
    });

    test('409 CONFLICT — assigning a plain comment is rejected by the entity guard', async () => {
      const app = await buildServer({ reviewComment: { findById: jest.fn(async () => comment()) } });
      const response = await patch(app, { op: 'assign', assigneeId: ASSIGNEE_ID });
      expect(response.statusCode).toBe(409);
      expect(response.json().error.code).toBe('CONFLICT');
      await app.close();
    });
  });

  describe('op=status', () => {
    test('200 — sets a task status and stamps resolution', async () => {
      const app = await buildServer({ reviewComment: { findById: jest.fn(async () => task()) } });
      const response = await patch(app, { op: 'status', status: 'resolved' });
      expect(response.statusCode).toBe(200);
      expect(response.json().data.status).toBe('resolved');
      expect(response.json().data.resolvedAt).toBeDefined();
      await app.close();
    });

    test('updates the item through reviewComment.update', async () => {
      const update = jest.fn(async () => undefined);
      const app = await buildServer({
        reviewComment: { findById: jest.fn(async () => task()), update },
      });
      await patch(app, { op: 'status', status: 'in_progress' });
      expect(update).toHaveBeenCalledTimes(1);
      await app.close();
    });
  });
});
