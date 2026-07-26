import type { ProjectDictionaryRepository } from '../../ports/grammar/project-dictionary.repository';
import type { ProjectMemberRepository } from '../../ports/project/project-member.repository';
import type { UserId } from '../../value-objects/ids/user-id';
import type { ProjectId } from '../../value-objects/ids/project-id';
import type { Result } from '../../types/result';
import type { DomainError } from '../../errors/domain-error';
import { ProjectDictionaryTerm } from '../../entities/project-dictionary-term';
import { requireDictionaryMember } from './grammar-authorization';

/**
 * Lists a project's shared dictionary. Any project member may read it (the terms are hydrated into
 * every collaborator's local checker).
 */
export class ListDictionaryTermsUseCase {
  /**
   * @param repo - The dictionary repository.
   * @param projectMemberRepo - Membership lookup for the read authorization check.
   */
  constructor(
    private readonly repo: ProjectDictionaryRepository,
    private readonly projectMemberRepo: ProjectMemberRepository,
  ) {}

  /**
   * Executes the use case.
   *
   * @param actorId - The user reading the dictionary.
   * @param projectId - The project whose dictionary to list.
   * @returns The project's dictionary terms, or a permission error.
   */
  async execute(
    actorId: UserId,
    projectId: ProjectId,
  ): Promise<Result<ProjectDictionaryTerm[], DomainError>> {
    const denied = await requireDictionaryMember(this.projectMemberRepo, projectId, actorId);
    if (denied) return { success: false, error: denied };
    const terms = await this.repo.listByProject(projectId);
    return { success: true, value: terms };
  }
}
