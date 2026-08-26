import type { FastifyInstance } from 'fastify';
import { ProjectId, UserId, type FileNode } from '@asciidocollab/domain';
import { GitWorkerTransportError, type GitWorkerPendingChange } from '@asciidocollab/infrastructure';
import type { FileGitStatus } from '@asciidocollab/shared';
import { getAuthenticatedUserId } from '../../../plugins/require-auth';
import { requireProjectMembership } from '../../../lib/git-write-lock';
import { sendGitErrorResponse, sendGitWorkerUnavailableResponse } from '../../../lib/git-error-response';

/** The public shape of the tree-status endpoint's response body. */
export interface TreeStatusDto {
  /** Every changed file's status, keyed by its `FileNode` id. A file with no pending change is absent, not `'unchanged'`. */
  statusByFileNodeId: Record<string, FileGitStatus>;
}

/**
 * Derives the single badge a file-tree entry shows for one pending change, in a fixed precedence
 * order (a file only ever gets one badge, even though a real working tree can combine states —
 * e.g. a partially-staged file is simultaneously staged and unstaged):
 *  1. `conflicted` — an unresolved merge conflict always wins.
 *  2. `untracked` — a brand-new, never-added file.
 *  3. `removed` — a deletion, whether staged or not.
 *  4. `staged` — staged for the next commit.
 *  5. `modified` — everything else (an unstaged edit to a tracked file).
 *
 * @param change - The worker's pending-change record.
 * @returns The `FileGitStatus` badge for this change.
 */
export function deriveFileGitStatus(change: GitWorkerPendingChange): FileGitStatus {
  if (change.state === 'conflicted') return 'conflicted';
  if (change.state === 'untracked') return 'untracked';
  if (change.changeType === 'removed') return 'removed';
  if (change.state === 'staged') return 'staged';
  return 'modified';
}

/**
 * Builds the file-tree status projection from the worker's flat pending-change list and the
 * project's `FileNode`s. Pure — no I/O — so the path-normalization and precedence logic is
 * unit-testable without a running worker or database.
 *
 * The worker reports paths workspace-relative with no leading slash; `FileNode` paths are stored
 * leading-slash absolute. A change with no matching `FileNode` (an internal `.git`/`.collab` path,
 * or a file not yet imported into the tree) is silently skipped — it has nothing to decorate.
 *
 * @param changes - Every pending change from the worker's status payload.
 * @param fileNodes - Every `FileNode` in the project.
 * @returns The `FileNodeId` -> `FileGitStatus` map.
 */
export function buildTreeStatus(
  changes: readonly GitWorkerPendingChange[],
  fileNodes: readonly FileNode[],
): TreeStatusDto {
  const fileNodeIdByPath = new Map<string, string>();
  for (const node of fileNodes) {
    fileNodeIdByPath.set(node.path.value, node.id.value);
  }

  const statusByFileNodeId: Record<string, FileGitStatus> = {};
  for (const change of changes) {
    const fileNodeId = fileNodeIdByPath.get(`/${change.path}`);
    if (!fileNodeId) continue;
    statusByFileNodeId[fileNodeId] = deriveFileGitStatus(change);
  }

  return { statusByFileNodeId };
}

/**
 * Registers `GET /projects/:projectId/git/tree-status` — a thin derivation of the same status the
 * `/git/status` endpoint reads, reshaped as a `FileNodeId` -> `FileGitStatus` map for the file tree
 * to render per-file badges from (the single source of truth the commit review also reads from).
 *
 * Any project member (viewer tier and up) may read this; the route gates membership itself BEFORE
 * calling the worker.
 *
 * @param app - The Fastify instance the endpoint is registered on.
 */
export async function gitTreeStatusRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { projectId: string } }>(
    '/api/projects/:projectId/git/tree-status',
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

      const fileNodes = await request.server.repos.fileNode.findByProjectId(projectId);
      const dto = buildTreeStatus(result.data.changes, fileNodes);
      return reply.status(200).send(dto);
    },
  );
}
