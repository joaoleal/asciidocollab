import type { ProjectDictionaryRepository } from '../../ports/grammar/project-dictionary.repository';
import type { ProjectMemberRepository } from '../../ports/project/project-member.repository';
import type { AuditLogRepository } from '../../ports/admin/audit-log.repository';
import type { Logger } from '../../ports/observability/logger';
import type { UserId } from '../../value-objects/ids/user-id';
import type { ProjectId } from '../../value-objects/ids/project-id';
import type { RequestContext } from '../../types/request-context';
import type { Result } from '../../types/result';
import type { DomainError } from '../../errors/domain-error';
import { ProjectDictionaryTermId } from '../../value-objects/ids/project-dictionary-term-id';
import { DictionaryTermNotFoundError } from '../../errors/grammar/dictionary-term-not-found';
import { AUDIT_DICTIONARY_TERM_REMOVED } from '../../audit-actions';
import { recordAuditSuccess } from '../audit-recording';
import { requireDictionaryEditor, DICTIONARY_RESOURCE_TYPE } from './grammar-authorization';

/**
 * Removes a term from a project's shared dictionary by id. Only a project editor or owner may remove;
 * the removal is audited. Removing a term that does not exist returns a not-found error.
 */
export class RemoveDictionaryTermUseCase {
  /**
   * @param repo - The dictionary repository.
   * @param projectMemberRepo - Membership lookup for the write authorization check.
   * @param auditLogRepo - Audit sink for the denial and success records.
   * @param logger - Optional observability sink for a swallowed audit failure.
   */
  constructor(
    private readonly repo: ProjectDictionaryRepository,
    private readonly projectMemberRepo: ProjectMemberRepository,
    private readonly auditLogRepo: AuditLogRepository,
    private readonly logger?: Logger,
  ) {}

  /**
   * Executes the use case.
   *
   * @param actorId - The user removing the term.
   * @param projectId - The project whose dictionary to remove from.
   * @param termId - The id of the term to remove.
   * @param context - Optional request origin captured into the audit records.
   * @returns Success (void), a permission error, or a not-found error.
   */
  async execute(
    actorId: UserId,
    projectId: ProjectId,
    termId: ProjectDictionaryTermId,
    context?: RequestContext,
  ): Promise<Result<void, DomainError>> {
    const denied = await requireDictionaryEditor(
      this.projectMemberRepo,
      this.auditLogRepo,
      { actorId, projectId, context },
      this.logger,
    );
    if (denied) return { success: false, error: denied };

    const removed = await this.repo.removeById(projectId, termId);
    if (!removed) return { success: false, error: new DictionaryTermNotFoundError(termId.value) };

    await recordAuditSuccess(
      this.auditLogRepo,
      {
        actorId,
        projectId,
        action: AUDIT_DICTIONARY_TERM_REMOVED,
        resourceType: DICTIONARY_RESOURCE_TYPE,
        resourceId: termId.value,
        context,
      },
      this.logger,
    );
    return { success: true, value: undefined };
  }
}
