import { UserId } from '../../value-objects/ids/user-id';
import { FileNodeId } from '../../value-objects/ids/file-node-id';
import { FileNodeRepository } from '../../ports/file-tree/file-node.repository';
import { ProjectMemberRepository } from '../../ports/project/project-member.repository';
import { PermissionDeniedError } from '../../errors/common/permission-denied';

/** The resource type recorded on ignored-lint authorization checks. */
export const IGNORED_LINT_RESOURCE_TYPE = 'IgnoredLint';

/**
 * Ensures the caller may access a document's ignored-lint record: the document must exist and the
 * caller must be a member of its project. The record itself is always scoped to the caller's own
 * `userId`, so this only prevents storing/reading ignores for a document the caller cannot see.
 *
 * @param fileNodeRepo - Resolves the document to its project.
 * @param projectMemberRepo - Membership lookup.
 * @param documentId - The document (FileNode) the ignores apply to.
 * @param actorId - The acting user.
 * @returns A {@link PermissionDeniedError} when the document is unknown or the caller is not a member, else null.
 */
export async function requireDocumentMember(
  fileNodeRepo: FileNodeRepository,
  projectMemberRepo: ProjectMemberRepository,
  documentId: FileNodeId,
  actorId: UserId,
): Promise<PermissionDeniedError | null> {
  const fileNode = await fileNodeRepo.findById(documentId);
  if (!fileNode) {
    return new PermissionDeniedError('Permission denied', IGNORED_LINT_RESOURCE_TYPE, documentId.value, 'unknown_document');
  }
  const membership = await projectMemberRepo.findByCompositeKey(fileNode.projectId, actorId);
  return membership
    ? null
    : new PermissionDeniedError('Permission denied', IGNORED_LINT_RESOURCE_TYPE, documentId.value, 'not_a_member');
}
