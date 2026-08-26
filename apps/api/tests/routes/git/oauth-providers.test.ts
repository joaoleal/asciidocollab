import Fastify, { type FastifyInstance } from 'fastify';
import { gitOAuthProvidersRoutes } from '../../../src/routes/git/oauth-providers';

const CONFIGURED = {
  clientId: 'client-id',
  clientSecret: 'secret',
  redirectUri: 'https://app.example.com/callback',
  scopes: 'repo',
  authorizeUrl: 'https://example.com/authorize',
  tokenUrl: 'https://example.com/token',
};

const UNCONFIGURED = { ...CONFIGURED, clientId: '' };

async function buildApp(oauth: { github: typeof CONFIGURED; gitlab: typeof CONFIGURED; bitbucket: typeof CONFIGURED }) {
  const app = Fastify();
  app.decorate('config', { git: { oauth } } as never);
  await app.register(gitOAuthProvidersRoutes);
  await app.ready();
  return app;
}

describe('GET /api/git/oauth/providers', () => {
  it('lists only providers with a configured clientId', async () => {
    const app = await buildApp({ github: CONFIGURED, gitlab: UNCONFIGURED, bitbucket: UNCONFIGURED });

    const response = await app.inject({ method: 'GET', url: '/api/git/oauth/providers' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ providers: ['github'] });

    await app.close();
  });

  it('returns an empty list when no provider is configured', async () => {
    const app = await buildApp({ github: UNCONFIGURED, gitlab: UNCONFIGURED, bitbucket: UNCONFIGURED });

    const response = await app.inject({ method: 'GET', url: '/api/git/oauth/providers' });

    expect(response.json()).toEqual({ providers: [] });

    await app.close();
  });

  it('lists every configured provider, in the fixed github/gitlab/bitbucket order', async () => {
    const app = await buildApp({ github: CONFIGURED, gitlab: CONFIGURED, bitbucket: CONFIGURED });

    const response = await app.inject({ method: 'GET', url: '/api/git/oauth/providers' });

    expect(response.json()).toEqual({ providers: ['github', 'gitlab', 'bitbucket'] });

    await app.close();
  });

  it('never leaks client secrets or redirect URIs in the response', async () => {
    const app = await buildApp({ github: CONFIGURED, gitlab: UNCONFIGURED, bitbucket: UNCONFIGURED });

    const response = await app.inject({ method: 'GET', url: '/api/git/oauth/providers' });

    expect(JSON.stringify(response.json())).not.toContain(CONFIGURED.clientSecret);
    expect(JSON.stringify(response.json())).not.toContain(CONFIGURED.redirectUri);

    await app.close();
  });
});
