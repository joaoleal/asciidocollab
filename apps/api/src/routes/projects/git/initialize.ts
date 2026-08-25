import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'crypto';
import {
  DomainError,
  GitProvider,
  GitRepository,
  GitRepositoryId,
  ProjectId,
  UserId,
} from '@asciidocollab/domain';
import { getAuthenticatedUserId } from '../../../plugins/require-auth';
import { requireOwnerRole } from '../../../lib/git-write-lock';
import { sendGitErrorResponse } from '../../../lib/git-error-response';

/** Body accepted by `POST /projects/:projectId/git/initialize`. */
interface GitInitializeBody {
  /** The git hosting provider, e.g. `'github'`, `'gitlab'`, or `'bitbucket'`. */
  provider: string;
  /** The remote repository's URL. Must currently be empty — this seeds it from the project. */
  remoteUrl: string;
  /** The plaintext access token to authenticate with. Never echoed back or logged. */
  token: string;
  /** The branch to initialize on. Defaults to `'main'` when omitted. */
  branch?: string;
}

/**
 * A remote URL this route will accept: either an `http(s)://` URL or a scp-style `git@host:path`
 * reference, neither containing whitespace or the shell metacharacters (`;`, `|`, `&`, backticks,
 * `$(`) an argument-injection attempt against the eventual `git` invocation would need. Mirrors
 * `POST /api/git/import`'s own boundary check.
 */
const VALID_REMOTE_URL_PATTERN = /^(?:https?:\/\/|git@)[^\s;|&`$]+$/;

/** Branch value stamped on a repository this route creates when none was requested. */
const DEFAULT_BRANCH = 'main';

/**
 * Registers `POST /projects/:projectId/git/initialize` — starts turning an existing, non-git
 * project into the initial commit of a brand new remote: any current files are committed and
 * pushed to an (expected-empty) remote the caller names, rather than a history being cloned in
 * (that is `POST /api/git/import`'s job).
 *
 * OWNER-gated (data-model.md's git authorization matrix), and — like import — ASYNCHRONOUS: the
 * actual init/commit/push happens later in the git-worker. Because `GitOperation.projectId` is a
 * NOT-NULL foreign key to an already-existing project here, this route only needs to pre-create the
 * project's `GitRepository` link (in its transient `DISCONNECTED` placeholder state — never a
 * steady-state value; see `GitSyncStatus`), store the encrypted credential, and enqueue the
 * `INITIALIZE` operation before answering `202`.
 *
 * A project already connected to a remote (a `GitRepository` row whose `syncStatus` is anything
 * other than the transient placeholder) is refused with `RepositoryAlreadyConnectedError` (409
 * `already_connected`) before anything is written. A leftover `DISCONNECTED` placeholder — from a
 * prior initialize attempt that never reached a terminal state, or that failed without the worker's
 * own cleanup running — is instead reused in place (the same `GitRepositoryId` is kept and the row
 * is overwritten with the newly requested provider/remoteUrl/branch): `GitRepository.projectId` is
 * unique, so minting a fresh id here for an existing row would violate that constraint rather than
 * safely retrying.
 *
 * @param app - The Fastify instance the endpoint is registered on.
 */
export async function gitInitializeRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Params: { projectId: string }; Body: GitInitializeBody }>(
    '/projects/:projectId/git/initialize',
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
            provider: { type: 'string' },
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

      const { remoteUrl, token, branch } = request.body;

      let provider: GitProvider;
      try {
        provider = GitProvider.create(request.body.provider);
      } catch (error) {
        if (error instanceof DomainError) {
          return sendGitErrorResponse(reply, error.name);
        }
        throw error;
      }

      if (!VALID_REMOTE_URL_PATTERN.test(remoteUrl)) {
        return reply.status(400).send({
          error: { code: 'validation_error', message: 'Invalid Git remote URL' },
        });
      }

      // A row whose syncStatus is anything but the transient placeholder means the project is
      // already connected to a remote; a project has a strict 1:1 relationship with one. A
      // leftover DISCONNECTED placeholder, by contrast, is a prior initialize attempt that never
      // finished — its row is reused (see the function docs), not treated as a conflict.
      const existing = await request.server.repos.gitRepository.findByProjectId(projectId);
      if (existing !== null && existing.syncStatus !== 'DISCONNECTED') {
        return sendGitErrorResponse(reply, 'RepositoryAlreadyConnectedError');
      }

      try {
        const gitRepository = new GitRepository(
          existing ? existing.id : GitRepositoryId.create(randomUUID()),
          projectId,
          provider,
          remoteUrl,
          // The credential store is keyed by projectId (one credential per project), so the
          // project id itself is the reference the repository link needs to find it back.
          projectId.value,
          branch ?? DEFAULT_BRANCH,
          'DISCONNECTED',
          branch ?? DEFAULT_BRANCH,
          null,
          null,
          new Date(),
          actorId,
        );
        await request.server.repos.gitRepository.save(gitRepository);

        const { gitCredentialStore } = request.server.services;
        if (!gitCredentialStore) {
          throw new Error('Git credential store is not configured');
        }
        await gitCredentialStore.save(projectId, { token, provider, createdByUserId: actorId });

        // Enqueue the actual init/commit/push. The git-worker claims this operation later,
        // decrypts the credential, and runs `InitializeRepositoryUseCase` against the rows written
        // above.
        const operation = await request.server.repos.gitOperation.enqueue({
          projectId,
          kind: 'INITIALIZE',
          triggeredByUserId: actorId,
          branch: branch ?? null,
        });

        return reply.status(202).send({
          operationId: operation.id.value,
          projectId: projectId.value,
        });
      } catch (error) {
        request.log.error(
          { err: error instanceof Error ? error.message : String(error), projectId: projectId.value },
          'Could not start initializing the git repository',
        );
        return reply.status(500).send({
          error: { code: 'internal_error', message: 'The initialize could not be started' },
        });
      }
    },
  );
}
