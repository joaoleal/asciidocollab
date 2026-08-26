import type { FastifyInstance } from 'fastify';
import { ProjectId, UserId } from '@asciidocollab/domain';
import { GitWorkerTransportError, type GitWorkerBranchListData } from '@asciidocollab/infrastructure';
import type { BranchDto, BranchListDto } from '@asciidocollab/shared';
import { getAuthenticatedUserId } from '../../../plugins/require-auth';
import { requireProjectMembership, requireEditorRole } from '../../../lib/git-write-lock';
import { sendGitErrorResponse, sendGitWorkerUnavailableResponse } from '../../../lib/git-error-response';

/**
 * Maps the sync-RPC's `{current, branches: string[]}` envelope to the wire `BranchListDto`,
 * flagging each branch's `isCurrent` against `current`. This mapping lives ONLY here, at the
 * domain-to-shared-DTO boundary — the domain result and the RPC client both stay in the plain
 * `{current, branches: string[]}` shape.
 *
 * @param data - The sync-RPC's branch-list payload.
 * @returns The public `BranchListDto`.
 */
export function toBranchListDto(data: GitWorkerBranchListData): BranchListDto {
  const branches: BranchDto[] = data.branches.map((name) => ({
    name,
    isCurrent: name === data.current,
  }));
  return { current: data.current, branches };
}

/**
 * Registers `GET /projects/:projectId/git/branches` — a project member's read of the connected
 * repository's local branches and which one is currently checked out — and
 * `POST /projects/:projectId/git/branches` — an editor's creation of a new branch from the
 * project's current branch tip.
 *
 * Both routes are synchronous, via the git-worker's `getBranches`/`createBranch` RPCs; neither
 * takes the project's single-flight guard (a branch list read and a branch creation are cheap,
 * non-content-changing actions).
 *
 * `GET` requires only VIEWER tier or above (any project member may read); `POST` requires EDITOR
 * tier or above, gated BEFORE the worker call as defense-in-depth alongside the worker's own
 * editor self-gate.
 *
 * @param app - The Fastify instance the endpoints are registered on.
 */
export async function gitBranchesRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { projectId: string } }>(
    '/api/projects/:projectId/git/branches',
    {
      schema: {
        params: {
          type: 'object',
          required: ['projectId'],
          properties: { projectId: { type: 'string' } },
        },
      },
    },
    async (request, reply) => {
      const actorId = UserId.create(getAuthenticatedUserId(request));
      const projectId = ProjectId.create(request.params.projectId);

      const membershipCheck = await requireProjectMembership(request, actorId, projectId);
      if (!membershipCheck.success) {
        return sendGitErrorResponse(reply, membershipCheck.error.name);
      }

      let result;
      try {
        result = await request.server.stores.gitWorkerClient.getBranches({
          projectId: projectId.value,
          actorId: actorId.value,
        });
      } catch (error) {
        if (error instanceof GitWorkerTransportError) {
          return sendGitWorkerUnavailableResponse(reply);
        }
        throw error;
      }

      if (!result.ok) {
        return sendGitErrorResponse(reply, result.error, result.path);
      }

      return reply.status(200).send(toBranchListDto(result.data));
    },
  );

  app.post<{ Params: { projectId: string }; Body: { name: string } }>(
    '/api/projects/:projectId/git/branches',
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
          required: ['name'],
          properties: {
            name: { type: 'string', minLength: 1 },
          },
        },
      },
    },
    async (request, reply) => {
      const actorId = UserId.create(getAuthenticatedUserId(request));
      const projectId = ProjectId.create(request.params.projectId);

      const editorCheck = await requireEditorRole(request, actorId, projectId);
      if (!editorCheck.success) {
        return sendGitErrorResponse(reply, editorCheck.error.name);
      }

      let result;
      try {
        result = await request.server.stores.gitWorkerClient.createBranch({
          projectId: projectId.value,
          actorId: actorId.value,
          name: request.body.name,
        });
      } catch (error) {
        if (error instanceof GitWorkerTransportError) {
          return sendGitWorkerUnavailableResponse(reply);
        }
        throw error;
      }

      if (!result.ok) {
        return sendGitErrorResponse(reply, result.error, result.path);
      }

      // A freshly-created branch is never the checked-out one — creation does not switch HEAD.
      const branch: BranchDto = { name: result.data.branch.name, isCurrent: false };
      return reply.status(200).send({ branch });
    },
  );
}
