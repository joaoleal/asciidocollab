import Fastify, { type FastifyRequest } from 'fastify';
import { requestLogger } from '../../src/lib/request-logger';

/** Runs one injected request and hands back the Fastify request object it was served with. */
async function captureRequest(): Promise<FastifyRequest> {
  const app = Fastify();
  const seen: FastifyRequest[] = [];
  app.get('/probe', async (request, reply) => {
    seen.push(request);
    return reply.status(200).send({ ok: true });
  });
  await app.inject({ method: 'GET', url: '/probe' });
  await app.close();
  if (seen.length === 0) throw new Error('the probe route never ran');
  return seen[0];
}

describe('requestLogger', () => {
  it('forwards the message and the supplied metadata to the request log', async () => {
    const request = await captureRequest();
    const warn = jest.spyOn(request.log, 'warn').mockImplementation(() => {});

    requestLogger(request).warn('audit write failed', { projectId: 'p-1' });

    expect(warn).toHaveBeenCalledWith({ projectId: 'p-1' }, 'audit write failed');
  });

  it('substitutes an empty metadata object when the caller omits it', async () => {
    const request = await captureRequest();
    const warn = jest.spyOn(request.log, 'warn').mockImplementation(() => {});

    requestLogger(request).warn('audit write failed');

    expect(warn).toHaveBeenCalledWith({}, 'audit write failed');
  });
});
