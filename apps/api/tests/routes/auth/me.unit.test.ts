import Fastify from 'fastify';
import { meRoute } from '../../../src/routes/auth/me';
import { decorateApp } from '../../helpers/decorate-app';

describe('GET /auth/me (unit)', () => {
  it('returns 401 when session has userId but user is not found in the database', async () => {
    const app = Fastify();
    app.addHook('preHandler', (request, _reply, done) => {
      (request as never as { session: { userId: string } }).session = {
        userId: '550e8400-e29b-41d4-a716-446655440001',
      };
      done();
    });
    decorateApp(app, 'repos', {
      user: { findById: jest.fn().mockResolvedValue(null) },
    });
    app.register(meRoute);
    await app.ready();

    const response = await app.inject({ method: 'GET', url: '/auth/me' });

    expect(response.statusCode).toBe(401);
    expect(JSON.parse(response.body).error.code).toBe('UNAUTHORIZED');
    await app.close();
  });
});
