import type { FastifyInstance } from 'fastify';
import { ProjectId, UserId } from '@asciidocollab/domain';
import { GitWorkerTransportError } from '@asciidocollab/infrastructure';
import type { GitProvider, GitRepositoryDto } from '@asciidocollab/shared';
import { getAuthenticatedUserId } from '../../../plugins/require-auth';
import { requireOwnerRole } from '../../../lib/git-write-lock';
import { sendGitErrorResponse, sendGitWorkerUnavailableResponse } from '../../../lib/git-error-response';

/** Body accepted by `POST /projects/:projectId/git/connect`. */
interface GitConnectBody {
  /** The git hosting provider, e.g. `'github'`, `'gitlab'`, or `'bitbucket'`. */
  provider: string;
  /** The URL of the already-existing remote repository to attach this project to. */
  remoteUrl: string;
  /** The plaintext access token to authenticate with. Never echoed back or logged. */
  token: string;
  /** The branch to check out initially. Defaults to `'main'` when omitted. */
  branch?: string;
}

/**
 * Registers `POST /projects/:projectId/git/connect` — attaches the project's current files to an
 * EXISTING remote the caller already has (no clone, no push): a `git ls-remote`
 * connectivity/authentication preflight, then the encrypted credential and the project's
 * `GitRepository` link are saved.
 *
 * Unlike `POST /projects/:projectId/git/initialize` (which stages an ASYNC init/commit/push against
 * an expected-empty remote), this route is SYNCHRONOUS: the preflight must run against the real
 * `GitCommandRunner`, which lives only in the git-worker, so this route calls the worker's own
 * internal `connect` RPC rather than a domain use case directly — mirroring how `commit`/`status`
 * reach the worker. `ConnectRepositoryUseCase` (constructed worker-side) self-gates OWNER and saves
 * the credential itself; the `requireOwnerRole` check here is defense-in-depth, run BEFORE the
 * worker call.
 *
 * @param app - The Fastify instance the endpoint is registered on.
 */
export async function gitConnectRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Params: { projectId: string }; Body: GitConnectBody }>(
    '/api/projects/:projectId/git/connect',
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
          required: ['projectId'],
          properties: { projectId: { type: 'string' } },
        },
        body: {
          type: 'object',
          required: ['provider', 'remoteUrl', 'token'],
          properties: {
            provider: { type: 'string', minLength: 1 },
            remoteUrl: { type: 'string', minLength: 1 },
            token: { type: 'string', minLength: 1 },
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

      const { provider, remoteUrl, token, branch } = request.body;

      let result;
      try {
        result = await request.server.stores.gitWorkerClient.connect({
          projectId: projectId.value,
          actorId: actorId.value,
          provider,
          remoteUrl,
          token,
          ...(branch !== undefined ? { branch } : {}),
        });
      } catch (error) {
        if (error instanceof GitWorkerTransportError) {
          return sendGitWorkerUnavailableResponse(reply);
        }
        throw error;
      }

      if (!result.ok) {
        return sendGitErrorResponse(reply, result.error);
      }

      const { repository } = result.data;
      const dto: GitRepositoryDto = {
        id: repository.id,
        projectId: repository.projectId,
        // The worker already validated this against GitProvider.create before ever saving the row,
        // so it is one of the DTO's own provider literals by construction.
        provider: repository.provider as GitProvider,
        remoteUrl: repository.remoteUrl,
        currentBranch: repository.currentBranch,
        defaultBranch: repository.defaultBranch,
        syncStatus: repository.syncStatus,
        lastSyncAt: repository.lastSyncAt,
        connectedByUserId: repository.connectedByUserId,
        createdAt: repository.createdAt,
      };
      return reply.status(201).send({ repository: dto });
    },
  );
}
