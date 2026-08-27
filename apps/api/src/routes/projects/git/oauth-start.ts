import type { FastifyInstance } from 'fastify';
import { ProjectId, UserId } from '@asciidocollab/domain';
import { getAuthenticatedUserId } from '../../../plugins/require-auth';
import { requireOwnerRole } from '../../../lib/git-write-lock';
import { sendGitErrorResponse } from '../../../lib/git-error-response';
import { isGitOAuthProviderName, isGitOAuthProviderConfigured } from '../../../config/schema-git';
import { buildAuthorizeUrl, generateCodeVerifier, deriveCodeChallenge } from '../../../lib/git-oauth';
import { mintOAuthState } from '../../../lib/git-oauth-state';

/** Body accepted by `POST /api/projects/:projectId/git/oauth/:provider/start`. */
interface GitOAuthStartBody {
  /** The URL of the already-existing remote repository to connect once the OAuth flow completes. */
  remoteUrl: string;
  /** The branch to check out initially. Defaults to `'main'` when omitted (mirrors PAT connect). */
  branch?: string;
}

/**
 * A remote URL this route will accept — mirrors the same check `ConnectRepositoryUseCase` and the
 * PAT connect route apply, run again here at the boundary before anything is minted into `state`.
 */
const VALID_REMOTE_URL_PATTERN = /^(?:https?:\/\/|git@)[^\s;|&`$]+$/;

/**
 * Registers `POST /api/projects/:projectId/git/oauth/:provider/start` — the first step of the
 * guided OAuth authorization-code + PKCE connect flow. OWNER-gated exactly like PAT `connect`
 * (connecting a remote grants every future EDITOR collaborator the ability to push under the
 * resulting credential). Generates a PKCE code verifier/challenge pair, mints an encrypted,
 * authenticated `state` blob carrying everything the callback step needs (including the verifier
 * and the caller's identity, for the callback's own CSRF check), and returns the URL to redirect
 * the browser to. Nothing is persisted here — the whole attempt lives only in the returned `state`
 * until the callback redeems it.
 *
 * @param app - The Fastify instance the endpoint is registered on.
 */
export async function gitOAuthStartRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Params: { projectId: string; provider: string }; Body: GitOAuthStartBody }>(
    '/api/projects/:projectId/git/oauth/:provider/start',
    {
      config: {
        rateLimit: {
          max: app.config.git.rateLimitMax,
          timeWindow: app.config.git.rateLimitWindow,
        },
      },
      schema: {
        params: {
          type: 'object',
          required: ['projectId', 'provider'],
          properties: {
            projectId: { type: 'string' },
            provider: { type: 'string' },
          },
        },
        body: {
          type: 'object',
          required: ['remoteUrl'],
          properties: {
            remoteUrl: { type: 'string', minLength: 1 },
            branch: { type: 'string', minLength: 1 },
          },
        },
      },
    },
    async (request, reply) => {
      const actorId = UserId.create(getAuthenticatedUserId(request));
      const projectId = ProjectId.create(request.params.projectId);

      const ownerCheck = await requireOwnerRole(request, actorId, projectId);
      if (!ownerCheck.success) {
        return sendGitErrorResponse(reply, ownerCheck.error.name);
      }

      const { provider: providerParameter } = request.params;
      if (!isGitOAuthProviderName(providerParameter)) {
        return reply.status(400).send({
          error: { code: 'validation_error', message: 'Unrecognized git provider' },
        });
      }
      const providerConfig = app.config.git.oauth[providerParameter];
      if (!isGitOAuthProviderConfigured(providerConfig)) {
        return reply.status(404).send({
          error: { code: 'oauth_not_configured', message: 'Guided OAuth connect is not available for this provider' },
        });
      }

      const { remoteUrl, branch } = request.body;
      if (!VALID_REMOTE_URL_PATTERN.test(remoteUrl)) {
        return reply.status(400).send({
          error: { code: 'validation_error', message: 'Invalid Git remote URL' },
        });
      }

      const codeVerifier = generateCodeVerifier();
      const codeChallenge = deriveCodeChallenge(codeVerifier);
      const state = mintOAuthState(request.server.services.gitOAuthStateEncryption, {
        projectId: projectId.value,
        actorId: actorId.value,
        provider: providerParameter,
        remoteUrl,
        ...(branch === undefined ? {} : { branch }),
        codeVerifier,
      });

      const authorizeUrl = buildAuthorizeUrl({
        authorizeUrl: providerConfig.authorizeUrl,
        clientId: providerConfig.clientId,
        redirectUri: providerConfig.redirectUri,
        scope: providerConfig.scopes,
        state,
        codeChallenge,
      });

      return reply.status(200).send({ authorizeUrl });
    },
  );
}
