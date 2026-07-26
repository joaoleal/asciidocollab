import type { IgnoredLintRepository } from '../../ports/grammar/ignored-lint.repository';
import type { FileNodeRepository } from '../../ports/file-tree/file-node.repository';
import type { ProjectMemberRepository } from '../../ports/project/project-member.repository';
import type { UserId } from '../../value-objects/ids/user-id';
import type { FileNodeId } from '../../value-objects/ids/file-node-id';
import type { Result } from '../../types/result';
import type { DomainError } from '../../errors/domain-error';
import { IgnoredLint } from '../../entities/ignored-lint';
import { IgnoredLintId } from '../../value-objects/ids/ignored-lint-id';
import { requireDocumentMember } from './ignored-lint-authorization';
import { randomUUID } from 'node:crypto';

/**
 * Replaces the caller's private ignored-lints blob for a document (full upsert, last-write-wins on
 * their own record). The blob is opaque privacy-hashed data — never document prose — and is never
 * visible to any other user. Not audited: it is per-user support data, not shared content.
 */
export class ReplaceIgnoredLintsUseCase {
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
   * @param actorId - The user writing their ignores.
   * @param documentId - The file node the ignores belong to.
   * @param ignoredLintsJson - The opaque blob to persist.
   * @returns Success (void), or a permission error.
   */
  async execute(
    actorId: UserId,
    documentId: FileNodeId,
    ignoredLintsJson: string,
  ): Promise<Result<void, DomainError>> {
    const denied = await requireDocumentMember(this.fileNodeRepo, this.projectMemberRepo, documentId, actorId);
    if (denied) return { success: false, error: denied };

    const existing = await this.repo.findByUserAndDocument(actorId, documentId);
    const id = existing?.id ?? IgnoredLintId.create(randomUUID());
    await this.repo.upsert(new IgnoredLint(id, actorId, documentId, ignoredLintsJson));
    return { success: true, value: undefined };
  }
}
