import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'crypto';
import {
  DomainError,
  GitProvider,
  GitRepository,
  GitRepositoryId,
  Project,
  ProjectId,
  ProjectName,
  UserId,
} from '@asciidocollab/domain';
import { getAuthenticatedUserId } from '../../plugins/require-auth';

/** Body accepted by `POST /api/git/import`. */
interface GitImportBody {
  /** The git hosting provider, e.g. `'github'`, `'gitlab'`, or `'bitbucket'`. */
  provider: string;
  /** The remote repository's URL. */
  remoteUrl: string;
  /** The plaintext access token to authenticate with. Never echoed back or logged. */
  token: string;
  /** The branch to import. Defaults to the remote's default branch when omitted. */
  branch?: string;
}

/**
 * A remote URL this route will accept: either an `http(s)://` URL or a scp-style `git@host:path`
 * reference, neither containing whitespace or the shell metacharacters (`;`, `|`, `&`, backticks,
 * `$(`) an argument-injection attempt against the eventual `git` invocation would need. This
 * mirrors the domain's own check (`ImportRepositoryUseCase`, `ConnectRepositoryUseCase`) — this
 * route validates independently at the boundary, before anything is ever written, rather than
 * relying on the worker to reject a malformed URL after the project identity already exists.
 */
const VALID_REMOTE_URL_PATTERN = /^(?:https?:\/\/|git@)[^\s;|&`$]+$/;

/** The name a new import falls back to when nothing usable can be derived from the remote URL. */
const FALLBACK_PROJECT_NAME = 'Imported repository';

/**
 * Branch/head value stamped on the pre-import `GitRepository` link. Never read while the project
 * stays invisible (memberless) — the worker overwrites it with what the clone actually observed,
 * or the project never becomes visible at all.
 */
const PENDING_BRANCH_PLACEHOLDER = 'pending';

/**
 * Derives a starting project name candidate from a remote URL: the last path segment, with any
 * trailing `.git` suffix removed (e.g. `https://github.com/acme/handbook.git` → `handbook`). Falls
 * back to a fixed name when nothing usable can be extracted.
 */
function deriveProjectNameCandidate(remoteUrl: string): string {
  const withoutGitSuffix = remoteUrl.replace(/\.git$/i, '');
  const segments = withoutGitSuffix
    .split(/[/:]+/)
    .map((segment) => segment.trim())
    .filter(Boolean);
  const lastSegment = segments.pop();
  return lastSegment && lastSegment.length > 0 ? lastSegment : FALLBACK_PROJECT_NAME;
}

/**
 * Builds the validated {@link ProjectName} for a freshly imported project. Falls back to a fixed
 * name when the derived candidate does not itself pass `ProjectName`'s own validation (for example
 * a remote URL whose final segment is implausibly long), so a well-formed name is guaranteed
 * whatever a remote URL looks like.
 *
 * @param remoteUrl - The remote repository's URL, already checked against
 *   {@link VALID_REMOTE_URL_PATTERN} by the caller.
 * @returns A valid project name.
 */
function deriveProjectName(remoteUrl: string): ProjectName {
  try {
    return ProjectName.create(deriveProjectNameCandidate(remoteUrl));
  } catch {
    return ProjectName.create(FALLBACK_PROJECT_NAME);
  }
}

/**
 * Registers `POST /api/git/import`, which starts importing a remote git repository as a brand new
 * project: any authenticated user may call it, since — unlike every other git route — there is no
 * pre-existing project to hold a membership/role check against. Importing is what grants the
 * caller their first one.
 *
 * Because the actual clone is a long-running operation and `GitOperation.projectId` is a NOT-NULL
 * foreign key, this route synchronously allocates the new project's identity (an invisible,
 * memberless `Project` row plus its pre-import `GitRepository` link), stores the encrypted
 * credential, and enqueues the import before answering — so the `202` it returns already names a
 * project the caller can poll. The clone itself runs later, in the git-worker, against exactly the
 * rows this handler writes.
 *
 * There is no persistence transaction wrapping these writes (the persistence layer exposes none),
 * so they are ordered so that a mid-way failure leaves at most the invisible `Project` row behind —
 * never a membership, and so never a project any read path can reach. Every failure past that point
 * is answered with a generic, safe 500: nothing about a persistence failure, and never the token, is
 * echoed back or logged.
 *
 * @param app - The Fastify instance the endpoint is registered on.
 */
export async function gitImportRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: GitImportBody }>(
    '/api/git/import',
    {
      config: {
        // The general git rate-limit hook (config.git.rateLimitMax/rateLimitWindow), applied the
        // same way project.clone's own rate limit is. This is a per-route request limit, not the
        // actor-scoped single-flight guard noted below — that guard is a separate, later concern.
        rateLimit: {
          max: app.config.git.rateLimitMax,
          timeWindow: app.config.git.rateLimitWindow,
        },
      },
      schema: {
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
      const { remoteUrl, token, branch } = request.body;

      let provider: GitProvider;
      try {
        provider = GitProvider.create(request.body.provider);
      } catch (error) {
        if (error instanceof DomainError) {
          return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', message: error.message } });
        }
        throw error;
      }

      if (!VALID_REMOTE_URL_PATTERN.test(remoteUrl)) {
        return reply.status(400).send({
          error: { code: 'VALIDATION_ERROR', message: 'Invalid Git remote URL' },
        });
      }

      const projectId = ProjectId.create(randomUUID());
      const projectName = deriveProjectName(remoteUrl);

      try {
        // 1. The invisible (memberless) project row. No membership is written here — the worker's
        //    import adds the owner membership as its commit point, so a run that never completes
        //    leaves this row unreachable by any owner-scoped read.
        const project = new Project(projectId, projectName, null, [], null);
        await request.server.repos.project.save(project);

        // 2. The repository link, in its pre-import placeholder state. `credentialReference` is the
        //    project id itself (the credential store is keyed by project), and `connectedByUserId`
        //    is the importing actor — both are preserved unchanged by the worker's completed write.
        //    `syncStatus` is `DISCONNECTED`: there is no transient/pending value in `GitSyncStatus`,
        //    and this placeholder is never read while the project stays invisible.
        const gitRepository = new GitRepository(
          GitRepositoryId.create(randomUUID()),
          projectId,
          provider,
          remoteUrl,
          projectId.value,
          branch ?? PENDING_BRANCH_PLACEHOLDER,
          'DISCONNECTED',
          branch ?? PENDING_BRANCH_PLACEHOLDER,
          null,
          null,
          new Date(),
          actorId,
        );
        await request.server.repos.gitRepository.save(gitRepository);

        // 3. The encrypted credential, keyed by the same project id. The adapter encrypts it and
        //    derives its display hint; the plaintext token is never persisted, logged, or returned
        //    as-is by anything reachable from this handler.
        const { gitCredentialStore } = request.server.services;
        if (!gitCredentialStore) {
          throw new Error('Git credential store is not configured');
        }
        await gitCredentialStore.save(projectId, { token, provider, createdByUserId: actorId });

        // 4. Enqueue the actual clone. The git-worker claims this operation later, decrypts the
        //    credential, and runs `ImportRepositoryUseCase` against the rows written above.
        //
        // Deliberately no project-scoped single-flight/409 guard here: a concurrent import request
        // mints its own distinct project, so there is nothing yet to serialize against. The
        // contract's `409 import-already-in-progress` is ACTOR-scoped (one import in flight per
        // caller) and belongs with the general rate-limit/guard work, layered in front of this
        // route rather than inside it.
        const operation = await request.server.repos.gitOperation.enqueue({
          projectId,
          kind: 'IMPORT',
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
          'Could not start the git import',
        );
        return reply.status(500).send({
          error: { code: 'GIT_IMPORT_FAILED', message: 'The import could not be started' },
        });
      }
    },
  );
}
