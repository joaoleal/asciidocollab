jest.mock('../../../src/plugins/require-auth', () => ({
  requireAuth: jest.fn((_request: unknown, _rep: unknown, done: () => void) => done()),
  getAuthenticatedUserId: jest.fn(() => '550e8400-e29b-41d4-a716-446655440001'),
}));

import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import {
  buildServer,
  auditMock,
  emitMock,
  task,
  ASSIGNEE_ID,
  itemUrl,
  documentItemsUrl as documentItemsUrl,
  documentBulkDeleteUrl as documentBulkDeleteUrl,
  projectBulkDeleteUrl,
} from './harness';

const anchorBody = { quote: { exact: 'passage' } };

/** Every editor-gated write, as a (name, request) pair against a built server. */
const writes: Array<{ name: string; run: (app: FastifyInstance) => Promise<LightMyRequestResponse> }> = [
  { name: 'create', run: (app) => app.inject({ method: 'POST', url: documentItemsUrl, payload: { kind: 'comment', body: 'x', anchor: anchorBody } }) },
  { name: 'reply', run: (app) => app.inject({ method: 'POST', url: `${itemUrl()}/replies`, payload: { body: 'x' } }) },
  { name: 'resolve', run: (app) => app.inject({ method: 'POST', url: `${itemUrl()}/resolve` }) },
  { name: 'react', run: (app) => app.inject({ method: 'POST', url: `${itemUrl()}/reactions`, payload: { emoji: '👍' } }) },
  { name: 'patch-assign', run: (app) => app.inject({ method: 'PATCH', url: itemUrl(), payload: { op: 'assign', assigneeId: ASSIGNEE_ID } }) },
  { name: 'reanchor', run: (app) => app.inject({ method: 'POST', url: `${itemUrl()}/reanchor`, payload: { anchor: anchorBody } }) },
  { name: 'delete', run: (app) => app.inject({ method: 'DELETE', url: itemUrl() }) },
  { name: 'doc-bulk-delete', run: (app) => app.inject({ method: 'POST', url: documentBulkDeleteUrl, payload: { confirm: true } }) },
];

describe('review RBAC + audit hardening (T042)', () => {
  describe('a viewer is forbidden from every write and the denial is audited', () => {
    test.each(writes)('403 FORBIDDEN + audited authz.denied — $name', async ({ run }) => {
      const app = await buildServer({ role: 'viewer' });
      const response = await run(app);
      expect(response.statusCode).toBe(403);
      expect(response.json().error.code).toBe('FORBIDDEN');
      const save = auditMock(app);
      expect(save).toHaveBeenCalledTimes(1);
      expect(save.mock.calls[0][0].action).toBe('authz.denied');
      expect(emitMock(app)).not.toHaveBeenCalled();
      await app.close();
    });
  });

  describe('a non-member is forbidden and audited', () => {
    test('403 FORBIDDEN on create when the caller is not a project member', async () => {
      const app = await buildServer({ role: null });
      const response = await app.inject({
        method: 'POST',
        url: documentItemsUrl,
        payload: { kind: 'comment', body: 'x', anchor: anchorBody },
      });
      expect(response.statusCode).toBe(403);
      expect(auditMock(app)).toHaveBeenCalledTimes(1);
      await app.close();
    });
  });

  describe('project-wide bulk delete is owner-only', () => {
    test('403 FORBIDDEN + audited — an editor may not clear the project', async () => {
      const app = await buildServer({ role: 'editor' });
      const response = await app.inject({
        method: 'POST',
        url: projectBulkDeleteUrl,
        payload: { confirm: true },
      });
      expect(response.statusCode).toBe(403);
      expect(response.json().error.code).toBe('FORBIDDEN');
      const save = auditMock(app);
      expect(save).toHaveBeenCalledTimes(1);
      expect(save.mock.calls[0][0].action).toBe('authz.denied');
      await app.close();
    });

    test('200 — an owner may clear the project', async () => {
      const app = await buildServer({
        role: 'owner',
        reviewComment: { deleteByProject: jest.fn(async () => 2) },
      });
      const response = await app.inject({
        method: 'POST',
        url: projectBulkDeleteUrl,
        payload: { confirm: true },
      });
      expect(response.statusCode).toBe(200);
      await app.close();
    });
  });

  describe('success-path audit actions (FR-019)', () => {
    test('create audits review.item_created', async () => {
      const app = await buildServer();
      await app.inject({ method: 'POST', url: documentItemsUrl, payload: { kind: 'comment', body: 'x', anchor: anchorBody } });
      const save = auditMock(app);
      expect(save).toHaveBeenCalledTimes(1);
      expect(save.mock.calls[0][0].action).toBe('review.item_created');
      await app.close();
    });

    test('resolve audits review.resolved', async () => {
      const app = await buildServer();
      await app.inject({ method: 'POST', url: `${itemUrl()}/resolve` });
      expect(auditMock(app).mock.calls[0][0].action).toBe('review.resolved');
      await app.close();
    });

    test('assign audits review.assigned', async () => {
      const app = await buildServer({ reviewComment: { findById: jest.fn(async () => task()) } });
      await app.inject({ method: 'PATCH', url: itemUrl(), payload: { op: 'assign', assigneeId: ASSIGNEE_ID } });
      expect(auditMock(app).mock.calls[0][0].action).toBe('review.assigned');
      await app.close();
    });

    test('delete audits review.item_deleted', async () => {
      const app = await buildServer();
      await app.inject({ method: 'DELETE', url: itemUrl() });
      expect(auditMock(app).mock.calls[0][0].action).toBe('review.item_deleted');
      await app.close();
    });

    test('document bulk-delete audits review.document_cleared', async () => {
      const app = await buildServer({ reviewComment: { deleteByDocument: jest.fn(async () => 1) } });
      await app.inject({ method: 'POST', url: documentBulkDeleteUrl, payload: { confirm: true } });
      expect(auditMock(app).mock.calls[0][0].action).toBe('review.document_cleared');
      await app.close();
    });

    test('project bulk-delete audits review.project_cleared', async () => {
      const app = await buildServer({ role: 'owner', reviewComment: { deleteByProject: jest.fn(async () => 1) } });
      await app.inject({ method: 'POST', url: projectBulkDeleteUrl, payload: { confirm: true } });
      expect(auditMock(app).mock.calls[0][0].action).toBe('review.project_cleared');
      await app.close();
    });
  });

  describe('error mapping — a missing item yields 404 NOT_FOUND', () => {
    const notFound = { reviewComment: { findById: jest.fn(async () => null) } };
    const cases: Array<{ name: string; run: (app: FastifyInstance) => Promise<LightMyRequestResponse> }> = [
      { name: 'reply', run: (app) => app.inject({ method: 'POST', url: `${itemUrl()}/replies`, payload: { body: 'x' } }) },
      { name: 'resolve', run: (app) => app.inject({ method: 'POST', url: `${itemUrl()}/resolve` }) },
      { name: 'patch-status', run: (app) => app.inject({ method: 'PATCH', url: itemUrl(), payload: { op: 'status', status: 'resolved' } }) },
      { name: 'reanchor', run: (app) => app.inject({ method: 'POST', url: `${itemUrl()}/reanchor`, payload: { anchor: anchorBody } }) },
      { name: 'delete', run: (app) => app.inject({ method: 'DELETE', url: itemUrl() }) },
    ];
    test.each(cases)('404 NOT_FOUND — $name', async ({ run }) => {
      const app = await buildServer(notFound);
      const response = await run(app);
      expect(response.statusCode).toBe(404);
      expect(response.json().error.code).toBe('NOT_FOUND');
      await app.close();
    });
  });
});
