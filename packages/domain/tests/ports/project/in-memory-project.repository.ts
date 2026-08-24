import { Project } from '../../../src/entities/project';
import { ProjectId } from '../../../src/value-objects/ids/project-id';
import { UserId } from '../../../src/value-objects/ids/user-id';
import { Timestamps } from '../../../src/value-objects/common/timestamps';
import {
  ProjectRepository,
  PaginationParameters,
  PaginatedProjects,
} from '../../../src/ports/project/project.repository';

/**
 * Rebuilds a project the way the database round trip does, so a caller can
 * never read back state the schema cannot hold.
 *
 * The root folder is the one field that is dropped: there is no column for it,
 * so the real mapper writes none and reconstructs every project with none. A
 * fake that handed back the very entity it was given would let a use case pass
 * on a value production always reports as absent.
 */
function asStored(project: Project): Project {
  return new Project(
    project.id,
    project.name,
    project.description,
    [...project.tags],
    null,
    new Timestamps(project.createdAt, project.updatedAt),
    project.archivedAt,
    project.mainFileNodeId,
    project.language,
  );
}

/**
 * In-memory implementation of ProjectRepository for testing.
 * Accepts an optional membership map for testing findByMemberId with non-owner members.
 */
export class InMemoryProjectRepository implements ProjectRepository {
  private readonly storage = new Map<string, Project>();
  private readonly membershipMap: Map<string, Set<string>>;

  /**
   * Creates a new InMemoryProjectRepository.
   *
   * @param membershipMap - Optional map of userId to set of projectIds for membership testing.
   */
  constructor(membershipMap?: Map<string, Set<string>>) {
    this.membershipMap = membershipMap || new Map();
  }

  /**
   * Adds a membership record for testing findByMemberId with non-owner members.
   *
   * @param projectId - The project to add membership for.
   * @param userId - The user to add as a member.
   */
  addMembership(projectId: ProjectId, userId: UserId): void {
    const userProjects = this.membershipMap.get(userId.value) || new Set();
    userProjects.add(projectId.value);
    this.membershipMap.set(userId.value, userProjects);
  }

  /**
   * Finds a project by its unique identifier.
   *
   * @param id - The unique identifier of the project.
   * @returns The project if found, null otherwise.
   */
  async findById(id: ProjectId): Promise<Project | null> {
    const stored = this.storage.get(id.value);
    return stored === undefined ? null : asStored(stored);
  }

  /**
   * Finds all projects where the user is a member (owner or member).
   *
   * @param userId - The unique identifier of the user.
   * @param pagination - Pagination parameters.
   * @param archivedOnly - When true, return only archived projects; when false, return only active ones.
   * @returns Paginated list of projects.
   */
  async findByMemberId(
    userId: UserId,
    pagination: PaginationParameters,
    archivedOnly = false,
  ): Promise<PaginatedProjects> {
    const memberProjectIds = this.membershipMap.get(userId.value) ?? new Set<string>();
    let all = [...this.storage.values()].filter(
      (p) => memberProjectIds.has(p.id.value),
    );
    all = archivedOnly
      ? all.filter((p) => p.archivedAt !== null)
      : all.filter((p) => p.archivedAt === null);
    const total = all.length;
    const page = pagination.page;
    const limit = pagination.limit;
    const projects = all.slice((page - 1) * limit, page * limit).map(asStored);
    return { projects, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  /**
   * Persists a project entity (create or update).
   *
   * @param project - The project entity to save.
   */
  async save(project: Project): Promise<void> {
    // A copy, not the caller's entity: a row does not keep changing after it is
    // written, and the copy is what drops the fields the schema has no column for.
    this.storage.set(project.id.value, asStored(project));
  }

  /**
   * Archives a project by calling its archive method.
   * The archive timestamp is managed by the Project entity.
   *
   * @param id - The unique identifier of the project to archive.
   * @param _archivedAt - The archive timestamp (unused, managed by entity).
   */
  async archive(id: ProjectId, _archivedAt: Date): Promise<void> {
    const project = this.storage.get(id.value);
    if (project) {
      project.archive();
      this.storage.set(id.value, project);
    }
  }

  /**
   * Restores an archived project by setting archivedAt to null.
   *
   * @param id - The unique identifier of the project to restore.
   */
  async restore(id: ProjectId): Promise<void> {
    const project = this.storage.get(id.value);
    if (project && project.archivedAt !== null) {
      project.restore();
      this.storage.set(id.value, project);
    }
  }

  /**
   * Removes a project by its unique identifier.
   *
   * @param id - The unique identifier of the project to delete.
   */
  async delete(id: ProjectId): Promise<void> {
    this.storage.delete(id.value);
  }
}
