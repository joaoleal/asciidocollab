import type { ProjectDictionaryRepository } from '../../ports/grammar/project-dictionary.repository';
import type { ProjectMemberRepository } from '../../ports/project/project-member.repository';
import type { AuditLogRepository } from '../../ports/admin/audit-log.repository';
import type { Logger } from '../../ports/observability/logger';
import type { UserId } from '../../value-objects/ids/user-id';
import type { ProjectId } from '../../value-objects/ids/project-id';
import type { RequestContext } from '../../types/request-context';
import type { Result } from '../../types/result';
import type { DomainError } from '../../errors/domain-error';
import { ProjectDictionaryTerm } from '../../entities/project-dictionary-term';
import { ProjectDictionaryTermId } from '../../value-objects/ids/project-dictionary-term-id';
import { ValidationError } from '../../errors/common/validation-error';
import { AUDIT_DICTIONARY_TERM_ADDED } from '../../audit-actions';
import { recordAuditSuccess } from '../audit-recording';
import { requireDictionaryEditor, DICTIONARY_RESOURCE_TYPE } from './grammar-authorization';
import { randomUUID } from 'node:crypto';

/**
 * Adds a term to a project's shared dictionary. Only a project editor or owner may add; the add is
 * audited. Idempotent on a case-insensitive duplicate — re-adding an existing term returns the existing
 * record rather than creating a second row (so `API` and `api` never both appear).
 */
export class AddDictionaryTermUseCase {
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
   * @param actorId - The user adding the term.
   * @param projectId - The project whose dictionary to add to.
   * @param term - The boundary-validated term text.
   * @param context - Optional request origin captured into the audit records.
   * @returns The stored (existing or new) term, or a permission/validation error.
   */
  async execute(
    actorId: UserId,
    projectId: ProjectId,
    term: string,
    context?: RequestContext,
  ): Promise<Result<ProjectDictionaryTerm, DomainError>> {
    const denied = await requireDictionaryEditor(
      this.projectMemberRepo,
      this.auditLogRepo,
      { actorId, projectId, context },
      this.logger,
    );
    if (denied) return { success: false, error: denied };

    // Case-insensitive dedupe: an accepted term is stored once regardless of casing.
    const existing = await this.repo.findByTerm(projectId, term);
    if (existing) return { success: true, value: existing };

    let entity: ProjectDictionaryTerm;
    try {
      entity = new ProjectDictionaryTerm(ProjectDictionaryTermId.create(randomUUID()), projectId, term, actorId);
    } catch (error) {
      if (error instanceof ValidationError) return { success: false, error };
      throw error;
    }

    try {
      await this.repo.add(entity);
    } catch (error) {
      // A concurrent add of the same term (a double-click or a second collaborator) can slip past the
      // case-insensitive pre-check above and lose the race on the unique (project, term) constraint.
      // Treat that as the idempotent duplicate it is: re-read and return the winner rather than a 500.
      const raced = await this.repo.findByTerm(projectId, term);
      if (raced) return { success: true, value: raced };
      throw error;
    }
    await recordAuditSuccess(
      this.auditLogRepo,
      {
        actorId,
        projectId,
        action: AUDIT_DICTIONARY_TERM_ADDED,
        resourceType: DICTIONARY_RESOURCE_TYPE,
        resourceId: entity.id.value,
        metadata: { term: entity.term },
        context,
      },
      this.logger,
    );
    return { success: true, value: entity };
  }
}
