import { ProjectMember } from '@asciidocollab/domain';
import type { ProjectId, ProjectMemberRepository, Role, UserId } from '@asciidocollab/domain';

function compositeKey(projectId: ProjectId, userId: UserId): string {
  return `${projectId.value}:${userId.value}`;
}

/**
 * A local, minimal in-memory `ProjectMemberRepository` fake for this app's tests. See
 * `in-memory-git-operation-repository.ts`'s class docs for why this app keeps its own fakes
 * rather than reusing `packages/domain/tests`'.
 */
export class InMemoryProjectMemberRepository implements ProjectMemberRepository {
  private readonly storage = new Map<string, ProjectMember>();

  async findByProjectId(projectId: ProjectId): Promise<ProjectMember[]> {
    return [...this.storage.values()].filter((member) => member.projectId.value === projectId.value);
  }

  async findByUserId(userId: UserId): Promise<ProjectMember[]> {
    return [...this.storage.values()].filter((member) => member.userId.value === userId.value);
  }

  async findByCompositeKey(projectId: ProjectId, userId: UserId): Promise<ProjectMember | null> {
    return this.storage.get(compositeKey(projectId, userId)) ?? null;
  }

  async addMember(member: ProjectMember): Promise<void> {
    this.storage.set(compositeKey(member.projectId, member.userId), member);
  }

  async removeMember(projectId: ProjectId, userId: UserId): Promise<void> {
    this.storage.delete(compositeKey(projectId, userId));
  }

  async updateRole(projectId: ProjectId, userId: UserId, newRole: Role): Promise<void> {
    const key = compositeKey(projectId, userId);
    const member = this.storage.get(key);
    if (!member) return;
    this.storage.set(key, new ProjectMember(member.projectId, member.userId, newRole, member.joinedAt));
  }

  async findSoleOwnerProjects(userId: UserId): Promise<Array<{ id: ProjectId; name: string }>> {
    const ownerMemberships = [...this.storage.values()].filter(
      (member) => member.userId.value === userId.value && member.role.value === 'owner',
    );
    return ownerMemberships.map((member) => ({ id: member.projectId, name: 'Project' }));
  }
}
