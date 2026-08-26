import type { FastifyInstance } from 'fastify';
import { ProjectId, UserId } from '@asciidocollab/domain';
import type { ActiveGitOperationDto, GitOperationStatusDto } from '@asciidocollab/shared';
import { getAuthenticatedUserId } from '../../../plugins/require-auth';
import { requireProjectMembership } from '../../../lib/git-write-lock';
import { sendGitErrorResponse } from '../../../lib/git-error-response';

/**
 * Registers `GET /projects/:projectId/git/active-operation` — a project member's read of whether
 * the project currently has ANY whole-project git operation in flight (`QUEUED`, `RUNNING`, or
 * `AWAITING_CONFLICT`), regardless of who triggered it or which kind it is. This is the
 * collaboration-facing "git activity" signal: it lets a member notice that another member's (or the
 * system's) git operation is running, derived from the same `GitOperation` row the progress-polling
 * status read (`operation-status.ts`) uses — there is no separate awareness channel.
 *
 * Gated by plain viewer-tier project membership, like `status.ts`/`behind-ahead.ts` — unlike the
 * per-operation status read, there is no invisible-import edge case here: a project only has this
 * endpoint's URL to poll once it is already visible to its members.
 *
 * @param app - The Fastify instance the endpoint is registered on.
 */
export async function gitActiveOperationRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { projectId: string } }>(
    '/api/projects/:projectId/git/active-operation',
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

      const operation = await request.server.repos.gitOperation.findActiveOperation(projectId);

      const dto: ActiveGitOperationDto = {
        operation: operation
          ? ({
              id: operation.id.value,
              kind: operation.kind,
              state: operation.state,
              progress: operation.progress,
              errorCode: operation.errorCode,
            } satisfies GitOperationStatusDto)
          : null,
      };
      return reply.status(200).send(dto);
    },
  );
}
