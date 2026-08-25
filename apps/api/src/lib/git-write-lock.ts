import type { FastifyReply } from 'fastify';
import { CONTENT_CHANGING_GIT_OPERATION_KINDS, type GitOperationRepository, type ProjectId } from '@asciidocollab/domain';

/**
 * The write-lock check shared by file-tree mutation routes and the collab edit-session gate: while
 * a content-changing git operation (import/pull/checkout — see `CONTENT_CHANGING_GIT_OPERATION_KINDS`)
 * is active for a project, neither may proceed. Read-only operations, and every other operation kind,
 * never trip this.
 *
 * @param gitOperationRepo - The repository to query for the project's active operation.
 * @param projectId - The project to check.
 * @returns true when a content-changing operation is currently active for the project.
 */
export async function isGitWriteLocked(
  gitOperationRepo: GitOperationRepository,
  projectId: ProjectId,
): Promise<boolean> {
  const active = await gitOperationRepo.findActiveOperation(projectId);
  return active !== null && CONTENT_CHANGING_GIT_OPERATION_KINDS.includes(active.kind);
}

/**
 * Sends the standard `409` response for a mutation (or new edit session) refused because a
 * content-changing git operation is currently running for the project.
 */
export function sendGitOperationInProgressError(reply: FastifyReply) {
  return reply.status(409).send({
    error: {
      code: 'git_operation_in_progress',
      message: 'A git operation is already in progress for this project',
    },
  });
}
