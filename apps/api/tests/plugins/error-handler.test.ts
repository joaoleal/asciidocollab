import Fastify from 'fastify';
import { errorHandler, notFoundHandler } from '../../src/plugins/error-handler';

function buildTestServer(throwValue: unknown) {
  const app = Fastify({ logger: false });
  app.setErrorHandler(errorHandler);
  app.setNotFoundHandler(notFoundHandler);
  app.get('/error', async () => {
    throw throwValue;
  });
  return app;
}

describe('errorHandler', () => {
  it('returns 500 INTERNAL_ERROR for a plain Error (no statusCode)', async () => {
    const app = buildTestServer(new Error('boom'));
    const response = await app.inject({ method: 'GET', url: '/error' });
    expect(response.statusCode).toBe(500);
    expect(JSON.parse(response.body).error.code).toBe('INTERNAL_ERROR');
  });

  it('returns 400 VALIDATION_ERROR for a FastifyError with statusCode 400', async () => {
    const error = Object.assign(new Error('bad input'), { statusCode: 400 });
    const app = buildTestServer(error);
    const response = await app.inject({ method: 'GET', url: '/error' });
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body).error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 429 RATE_LIMITED with retryAfter from headers', async () => {
    const error = Object.assign(new Error('too many'), {
      statusCode: 429,
      headers: { 'retry-after': '30' },
    });
    const app = buildTestServer(error);
    const response = await app.inject({ method: 'GET', url: '/error' });
    expect(response.statusCode).toBe(429);
    const body = JSON.parse(response.body);
    expect(body.error.code).toBe('RATE_LIMITED');
    expect(body.error.retryAfter).toBe(30);
  });

  it('returns retryAfter=60 when headers is missing', async () => {
    const error = Object.assign(new Error('too many'), { statusCode: 429 });
    const app = buildTestServer(error);
    const response = await app.inject({ method: 'GET', url: '/error' });
    expect(JSON.parse(response.body).error.retryAfter).toBe(60);
  });

  it('returns retryAfter=60 when headers is not an object', async () => {
    const error = Object.assign(new Error('too many'), { statusCode: 429, headers: 'bad' });
    const app = buildTestServer(error);
    const response = await app.inject({ method: 'GET', url: '/error' });
    expect(JSON.parse(response.body).error.retryAfter).toBe(60);
  });

  it('returns retryAfter=60 when retry-after key is absent', async () => {
    const error = Object.assign(new Error('too many'), { statusCode: 429, headers: {} });
    const app = buildTestServer(error);
    const response = await app.inject({ method: 'GET', url: '/error' });
    expect(JSON.parse(response.body).error.retryAfter).toBe(60);
  });

  it('returns retryAfter=60 when retry-after value is not a finite number', async () => {
    const error = Object.assign(new Error('too many'), {
      statusCode: 429,
      headers: { 'retry-after': 'abc' },
    });
    const app = buildTestServer(error);
    const response = await app.inject({ method: 'GET', url: '/error' });
    expect(JSON.parse(response.body).error.retryAfter).toBe(60);
  });
});

describe('notFoundHandler', () => {
  it('returns 404 NOT_FOUND for unknown routes', async () => {
    const app = buildTestServer(new Error('unused'));
    const response = await app.inject({ method: 'GET', url: '/nonexistent-route' });
    expect(response.statusCode).toBe(404);
    expect(JSON.parse(response.body).error.code).toBe('NOT_FOUND');
  });
});
