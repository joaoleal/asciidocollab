import type { FastifyInstance, FastifyReply } from 'fastify';
import { GitWorkerTransportError } from '@asciidocollab/infrastructure';
import { getAuthenticatedUserId } from '../../plugins/require-auth';
import { isGitOAuthProviderName } from '../../config/schema-git';
import { exchangeCodeForToken } from '../../lib/git-oauth';
import { readOAuthState } from '../../lib/git-oauth-state';

/** Query parameters `GET /api/git/oauth/:provider/callback` accepts. */
interface GitOAuthCallbackQuery {
  /** The authorization code the provider issued, present on a successful consent. */
  code?: string;
  /** The `state` value this server minted at the start step, echoed back verbatim by the provider. */
  state?: string;
  /** Present instead of `code` when the user declined consent, or the provider otherwise refused. */
  error?: string;
}

/** Redirects to a generic, project-less failure indicator — used whenever `state` itself could not be trusted. */
function redirectGenericFailure(reply: FastifyReply, frontendUrl: string): FastifyReply {
  return reply.redirect(`${frontendUrl}/dashboard?gitOAuthError=1`, 302);
}

/** Redirects to the given project's settings page with a failure indicator — used once `state` decrypted successfully. */
function redirectProjectFailure(reply: FastifyReply, frontendUrl: string, projectId: string): FastifyReply {
  return reply.redirect(`${frontendUrl}/dashboard/projects/${projectId}/settings?gitOAuth=failed`, 302);
}

/** Redirects to the given project's settings page with a success indicator. */
function redirectSuccess(reply: FastifyReply, frontendUrl: string, projectId: string): FastifyReply {
  return reply.redirect(`${frontendUrl}/dashboard/projects/${projectId}/settings?gitOAuth=connected`, 302);
}

/**
 * Registers `GET /api/git/oauth/:provider/callback` — the second step of the guided OAuth
 * authorization-code + PKCE connect flow, and the only place the exchanged access token exists
 * outside the encrypted credential store. NOT project-scoped in its path: the target project lives
 * inside the (encrypted, authenticated) `state` parameter, not the URL.
 *
 * Every step below fails closed with a generic redirect, in this order: `state` must decrypt and
 * parse (an unreadable/tampered/malformed `state` is indistinguishable from an expired one to the
 * caller — both just bounce to the generic failure page); it must not be expired; the
 * authenticated caller must be the same user who started the attempt (`state.actorId` — the CSRF
 * bind); the code exchange against the provider's token endpoint must succeed; and finally
 * `ConnectRepositoryUseCase` (reached the same way the PAT connect route reaches it — the
 * git-worker's `connect` RPC — never forked or reimplemented) must accept the connection. Nothing
 * about *why* a given attempt failed is ever put in the redirect URL, a log line, or a response
 * body: not the code, the verifier, the client secret, the access token, or the underlying error.
 *
 * @param app - The Fastify instance the endpoint is registered on.
 */
export async function gitOAuthCallbackRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { provider: string }; Querystring: GitOAuthCallbackQuery }>(
    '/api/git/oauth/:provider/callback',
    {
      schema: {
        params: {
          type: 'object',
          required: ['provider'],
          properties: { provider: { type: 'string' } },
        },
        querystring: {
          type: 'object',
          properties: {
            code: { type: 'string' },
            state: { type: 'string' },
            error: { type: 'string' },
          },
        },
      },
    },
    async (request, reply) => {
      const frontendUrl = app.config.api.frontendUrl;
      const actorId = getAuthenticatedUserId(request);

      const { provider } = request.params;
      if (!isGitOAuthProviderName(provider)) {
        return redirectGenericFailure(reply, frontendUrl);
      }

      const { code, state, error } = request.query;
      if (error !== undefined || code === undefined || state === undefined) {
        return redirectGenericFailure(reply, frontendUrl);
      }

      const stateResult = readOAuthState(request.server.services.gitOAuthStateEncryption, state);
      if (!stateResult.success) {
        // Nothing decrypted, so there is no project to redirect back to with context.
        return redirectGenericFailure(reply, frontendUrl);
      }
      const oauthState = stateResult.value;

      // CSRF bind: the session redeeming this state must be the one that minted it. Checked before
      // anything else that would need the state's contents, so a mismatched caller can never trigger
      // a token exchange or a connect attempt for a project they didn't start this flow from.
      if (oauthState.actorId !== actorId) {
        request.log.warn({ reason: 'actor_mismatch' }, 'git oauth callback rejected');
        return redirectProjectFailure(reply, frontendUrl, oauthState.projectId);
      }

      if (oauthState.provider !== provider) {
        request.log.warn({ reason: 'provider_mismatch' }, 'git oauth callback rejected');
        return redirectProjectFailure(reply, frontendUrl, oauthState.projectId);
      }

      const providerConfig = app.config.git.oauth[provider];
      if (providerConfig.clientId.length === 0) {
        // The provider was configured when the attempt started but no longer is (a config change
        // mid-flight) — fail closed exactly as if it had never been configured.
        return redirectProjectFailure(reply, frontendUrl, oauthState.projectId);
      }

      const exchangeResult = await exchangeCodeForToken({
        tokenUrl: providerConfig.tokenUrl,
        code,
        codeVerifier: oauthState.codeVerifier,
        clientId: providerConfig.clientId,
        clientSecret: providerConfig.clientSecret,
        redirectUri: providerConfig.redirectUri,
      });
      if (!exchangeResult.success) {
        request.log.warn({ reason: exchangeResult.error.reason }, 'git oauth token exchange failed');
        return redirectProjectFailure(reply, frontendUrl, oauthState.projectId);
      }

      let connectResult;
      try {
        connectResult = await request.server.stores.gitWorkerClient.connect({
          projectId: oauthState.projectId,
          actorId: oauthState.actorId,
          provider: oauthState.provider,
          remoteUrl: oauthState.remoteUrl,
          token: exchangeResult.value.accessToken,
          ...(oauthState.branch === undefined ? {} : { branch: oauthState.branch }),
        });
      } catch (error_) {
        if (error_ instanceof GitWorkerTransportError) {
          return redirectProjectFailure(reply, frontendUrl, oauthState.projectId);
        }
        throw error_;
      }

      if (!connectResult.ok) {
        request.log.warn({ reason: connectResult.error }, 'git oauth connect refused');
        return redirectProjectFailure(reply, frontendUrl, oauthState.projectId);
      }

      return redirectSuccess(reply, frontendUrl, oauthState.projectId);
    },
  );
}
