import Fastify from 'fastify';
import { collabContentChangedRoute } from '../../../src/routes/internal/collab-content-changed';
import { COLLAB_CONTENT_CHANGED_PATH } from '@asciidocollab/shared';
import { decorateApp } from '../../helpers/decorate-app';

const PROJECT_ID = '550e8400-e29b-41d4-a716-446655440002';
const YJS_STATE_ID = '550e8400-e29b-41d4-a716-446655440003';
const FILE_NODE_ID = '550e8400-e29b-41d4-a716-446655440005';

function buildTestServer(options: { document?: unknown | null } = {}) {
  const { document = { fileNodeId: { value: FILE_NODE_ID } } } = options;
  const app = Fastify();
  const emit = jest.fn();

  decorateApp(app, 'repos', {
    document: { findByYjsStateId: jest.fn().mockResolvedValue(document) },
  });
  decorateApp(app, 'fileTreeEventBus', { emit, subscribe: jest.fn() });

  app.register(collabContentChangedRoute);
  return { app, emit };
}

describe(`POST ${COLLAB_CONTENT_CHANGED_PATH}`, () => {
  test('maps yjsStateId → fileNodeId and emits a content-changed event scoped to the project', async () => {
    const { app, emit } = buildTestServer();
    const response = await app.inject({
      method: 'POST',
      url: COLLAB_CONTENT_CHANGED_PATH,
      payload: { projectId: PROJECT_ID, yjsStateId: YJS_STATE_ID },
    });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ ok: true });
    expect(emit).toHaveBeenCalledWith(PROJECT_ID, { type: 'content-changed', fileNodeId: FILE_NODE_ID });
  });

  test('unknown yjsStateId → ok:true with no emit', async () => {
    const { app, emit } = buildTestServer({ document: null });
    const response = await app.inject({
      method: 'POST',
      url: COLLAB_CONTENT_CHANGED_PATH,
      payload: { projectId: PROJECT_ID, yjsStateId: YJS_STATE_ID },
    });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ ok: true });
    expect(emit).not.toHaveBeenCalled();
  });

  test('rejects a non-uuid yjsStateId at the schema boundary', async () => {
    const { app, emit } = buildTestServer();
    const response = await app.inject({
      method: 'POST',
      url: COLLAB_CONTENT_CHANGED_PATH,
      payload: { projectId: PROJECT_ID, yjsStateId: 'not-a-uuid' },
    });
    expect(response.statusCode).toBe(400);
    expect(emit).not.toHaveBeenCalled();
  });

  test('rejects a missing projectId', async () => {
    const { app } = buildTestServer();
    const response = await app.inject({
      method: 'POST',
      url: COLLAB_CONTENT_CHANGED_PATH,
      payload: { yjsStateId: YJS_STATE_ID },
    });
    expect(response.statusCode).toBe(400);
  });
});
