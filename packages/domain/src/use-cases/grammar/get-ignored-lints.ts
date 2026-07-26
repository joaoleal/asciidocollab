import type { IgnoredLintRepository } from '../../ports/grammar/ignored-lint.repository';
import type { FileNodeRepository } from '../../ports/file-tree/file-node.repository';
import type { ProjectMemberRepository } from '../../ports/project/project-member.repository';
import type { UserId } from '../../value-objects/ids/user-id';
import type { FileNodeId } from '../../value-objects/ids/file-node-id';
import type { Result } from '../../types/result';
import type { DomainError } from '../../errors/domain-error';
import { requireDocumentMember } from './ignored-lint-authorization';

/**
 * Reads the caller's private ignored-lints blob for a document. Only the caller's own record is ever
 * returned (scoped by the authenticated `userId`); an empty string means they have ignored nothing.
 */
export class GetIgnoredLintsUseCase {
  /**
   * @param repo - The ignored-lint repository.
   * @param fileNodeRepo - Resolves the document to its project for the membership check.
   * @param projectMemberRepo - Membership lookup.
   */
  constructor(
    private readonly repo: IgnoredLintRepository,
    private readonly fileNodeRepo: FileNodeRepository,
    private readonly projectMemberRepo: ProjectMemberRepository,
  ) {}

  /**
   * Executes the use case.
   *
   * @param actorId - The user reading their ignores.
   * @param documentId - The file node whose ignores are being read.
   * @returns The caller's blob (empty string when none), or a permission error.
   */
  async execute(actorId: UserId, documentId: FileNodeId): Promise<Result<string, DomainError>> {
    const denied = await requireDocumentMember(this.fileNodeRepo, this.projectMemberRepo, documentId, actorId);
    if (denied) return { success: false, error: denied };
    const record = await this.repo.findByUserAndDocument(actorId, documentId);
    return { success: true, value: record?.ignoredLintsJson ?? '' };
  }
}
