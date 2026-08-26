import type { FastifyInstance } from 'fastify';
import { GIT_OAUTH_PROVIDER_NAMES, isGitOAuthProviderConfigured } from '../../config/schema-git';

/**
 * Registers `GET /api/git/oauth/providers` — the guided-connect availability signal the web app
 * reads to decide whether to show a "Connect with <provider>" button: any authenticated user may
 * call it (it names no project and reveals nothing about any project), and it only ever answers
 * with provider NAMES, never any part of a provider's configuration (client id/secret, redirect
 * URI, endpoints).
 *
 * @param app - The Fastify instance the endpoint is registered on.
 */
export async function gitOAuthProvidersRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/git/oauth/providers', async (_request, reply) => {
    const providers = GIT_OAUTH_PROVIDER_NAMES.filter((name) =>
      isGitOAuthProviderConfigured(app.config.git.oauth[name]),
    );
    return reply.status(200).send({ providers });
  });
}
