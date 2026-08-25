import { UserId } from '../../value-objects/ids/user-id';
import { ProjectId } from '../../value-objects/ids/project-id';
import { YjsStateId } from '../../value-objects/ids/yjs-state-id';
import { ProjectMemberRepository } from '../../ports/project/project-member.repository';
import { FileNodeRepository } from '../../ports/file-tree/file-node.repository';
import { DocumentRepository } from '../../ports/file-tree/document.repository';
import { GitOperationRepository } from '../../ports/git/git-operation-repository';
import { CONTENT_CHANGING_GIT_OPERATION_KINDS } from '../../types/git-operation-kind';
import { CollabConnectionDeniedError } from '../../errors/content/collab-connection-denied';
import { CollabRole, toCollabRole } from './collab-role';
import { Result } from '../../types/result';

/** Authorization decision for a collaboration WebSocket connection. */
export interface CollabConnectionAuthorization {
  /** The requesting user's collaboration role for the document. */
  role: CollabRole;
}

/**
 * Authorizes a collaboration WebSocket connection to a document identified by its Yjs state id,
 * applying the same membership + document-ownership + role-mapping rules as the REST collab-info
 * path so the WS gate and the REST gate cannot disagree. Used by the internal collab-auth endpoint.
 */
export class AuthorizeCollabConnectionUseCase {
  /** Initializes the use case with the repositories needed to resolve ownership and membership. */
  constructor(
    private readonly projectMemberRepo: ProjectMemberRepository,
    private readonly fileNodeRepo: FileNodeRepository,
    private readonly documentRepo: DocumentRepository,
    private readonly gitOperationRepo: GitOperationRepository,
  ) {}

  /**
   * Verifies the document exists, belongs to the claimed project, and the actor is a member, then
   * resolves the actor's collaboration role.
   *
   * @param actorId - The authenticated user requesting the connection.
   * @param projectId - The project claimed in the room name.
   * @param yjsStateId - The Yjs state id identifying the document/room.
   * @returns The authorized role, or a `CollabConnectionDeniedError` carrying the denial reason.
   */
  async execute(
    actorId: UserId,
    projectId: ProjectId,
    yjsStateId: YjsStateId,
  ): Promise<Result<CollabConnectionAuthorization, CollabConnectionDeniedError>> {
    const document = await this.documentRepo.findByYjsStateId(yjsStateId);
    if (!document) {
      return { success: false, error: new CollabConnectionDeniedError('document_not_found') };
    }

    // Verify the document belongs to the project claimed in the room name; without this a user
    // could pair their own projectId with another project's yjsStateId to reach a document they
    // have no access to.
    const fileNode = await this.fileNodeRepo.findById(document.fileNodeId);
    if (!fileNode || !fileNode.projectId.equals(projectId)) {
      return { success: false, error: new CollabConnectionDeniedError('cross_project') };
    }

    const member = await this.projectMemberRepo.findByCompositeKey(projectId, actorId);
    if (!member) {
      return { success: false, error: new CollabConnectionDeniedError('not_a_member') };
    }

    // Write-lock: a content-changing op (import/pull/checkout) is currently replacing this
    // project's working tree, so no new edit session may open until it finishes — the same signal
    // the file-tree mutation routes return as a 409.
    const activeOperation = await this.gitOperationRepo.findActiveOperation(projectId);
    if (activeOperation && CONTENT_CHANGING_GIT_OPERATION_KINDS.includes(activeOperation.kind)) {
      return { success: false, error: new CollabConnectionDeniedError('git_operation_in_progress') };
    }

    return { success: true, value: { role: toCollabRole(member.role.value) } };
  }
}
