import type { ProjectRepository } from '../../ports/project/project.repository';
import type { ProjectMemberRepository } from '../../ports/project/project-member.repository';
import type { UserId } from '../../value-objects/ids/user-id';
import type { ProjectId } from '../../value-objects/ids/project-id';
import type { Result } from '../../types/result';
import type { DomainError } from '../../errors/domain-error';
import { PermissionDeniedError } from '../../errors/common/permission-denied';
import { ProjectNotFoundError } from '../../errors/project/project-not-found';
import { GIT_IGNORE_PATTERNS_RESOURCE_TYPE } from './git-ignore-patterns-authorization';

/** The read result: the project's currently-saved maintainer-editable git-ignore patterns. */
export interface GitIgnorePatternsResult {
  /** Newline-separated pattern lines, or null when none are set. */
  gitIgnorePatterns: string | null;
}

/**
 * Reads a project's maintainer-editable git-ignore patterns (the lines merged into the managed
 * `.gitignore`, alongside the always-ignored internal entries). Only the project owner may read
 * them — this is an owner-level project setting, not general project content, so unlike other
 * project-settings reads this one is owner-gated rather than member-readable. No audit entry is
 * recorded on a denied read (reads are cheap and non-mutating, matching the other settings reads).
 */
export class GetProjectGitIgnorePatternsUseCase {
  /**
   * @param projectRepo - Loads the project.
   * @param projectMemberRepo - Resolves the caller's membership for the owner-only check.
   */
  constructor(
    private readonly projectRepo: ProjectRepository,
    private readonly projectMemberRepo: ProjectMemberRepository,
  ) {}

  /**
   * @param actorId - The user requesting the patterns.
   * @param projectId - The project whose patterns to read.
   * @returns The stored patterns, or a typed domain error.
   */
  async execute(actorId: UserId, projectId: ProjectId): Promise<Result<GitIgnorePatternsResult, DomainError>> {
    const project = await this.projectRepo.findById(projectId);
    if (!project) {
      return { success: false, error: new ProjectNotFoundError(projectId.value) };
    }

    const membership = await this.projectMemberRepo.findByCompositeKey(projectId, actorId);
    if (membership?.role.value !== 'owner') {
      return {
        success: false,
        error: new PermissionDeniedError(
          'Permission denied',
          GIT_IGNORE_PATTERNS_RESOURCE_TYPE,
          projectId.value,
          membership ? 'not_owner' : 'not_a_project_member',
        ),
      };
    }

    return { success: true, value: { gitIgnorePatterns: project.gitIgnorePatterns } };
  }
}
