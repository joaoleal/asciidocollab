import type { FastifyInstance } from 'fastify';
import { ProjectId, UserId } from '@asciidocollab/domain';
import { GitWorkerTransportError, type GitWorkerStatusData } from '@asciidocollab/infrastructure';
import type { GitStatusDto, PendingChangeDto } from '@asciidocollab/shared';
import { getAuthenticatedUserId } from '../../../plugins/require-auth';
import { requireProjectMembership } from '../../../lib/git-write-lock';
import { sendGitErrorResponse, sendGitWorkerUnavailableResponse } from '../../../lib/git-error-response';

/**
 * Buckets the git-worker's flat `changes` list into the four state buckets a `GitStatusDto`
 * exposes, and maps the remaining wire fields straight through. Pure — no I/O — so the bucketing
 * and field-mapping logic is unit-testable without a running worker.
 *
 * @param data - The worker's status payload.
 * @returns The public `GitStatusDto`.
 */
export function bucketStatus(data: GitWorkerStatusData): GitStatusDto {
  const staged: PendingChangeDto[] = [];
  const unstaged: PendingChangeDto[] = [];
  const untracked: PendingChangeDto[] = [];
  const conflicted: PendingChangeDto[] = [];
  const buckets = { staged, unstaged, untracked, conflicted };

  for (const change of data.changes) {
    buckets[change.state].push({ path: change.path, changeType: change.changeType });
  }

  return {
    branch: data.currentBranch,
    syncStatus: data.syncStatus,
    // The worker reports only the qualitative syncStatus today, not a numeric commit count; a
    // dedicated ahead/behind computation is a separate, not-yet-built capability, so these stay a
    // fixed placeholder until it lands.
    ahead: 0,
    behind: 0,
    lastSyncAt: data.lastSyncAt,
    staged,
    unstaged,
    untracked,
    conflicted,
  };
}

/**
 * Registers `GET /projects/:projectId/git/status` — a project member's read of the connected
 * repository's working-tree status: current branch, sync standing, and every pending change
 * bucketed by where it stands (staged/unstaged/untracked/conflicted).
 *
 * Any project member (viewer tier and up) may read status; the route gates membership itself
 * BEFORE calling the worker, since the underlying worker call performs no authorization of its own.
 *
 * @param app - The Fastify instance the endpoint is registered on.
 */
export async function gitStatusRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { projectId: string } }>(
    '/api/projects/:projectId/git/status',
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
        result = await request.server.stores.gitWorkerClient.getStatus({
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

      const dto: GitStatusDto = bucketStatus(result.data);
      return reply.status(200).send(dto);
    },
  );
}
