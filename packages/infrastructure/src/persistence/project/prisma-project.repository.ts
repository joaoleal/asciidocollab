import { PrismaClient } from '@prisma/client';
import {
  Project,
  ProjectId,
  UserId,
  ProjectName,
  FileNodeId,
  Timestamps,
  ProjectRepository,
  PaginationParameters,
  PaginatedProjects,
  isSpellcheckLanguage,
} from '@asciidocollab/domain';

/**
 * Prisma-backed implementation of the `ProjectRepository` interface.
 * Maps between domain `Project` entities and the `Project` database table,
 * including tags stored as a JSON array and nullable description.
 */
export class PrismaProjectRepository implements ProjectRepository {
  /**
   * Creates a new PrismaProjectRepository.
   *
   * @param prisma - The Prisma client used for database operations.
   */
  constructor(
    /** The Prisma client used for database operations. */
    private readonly prisma: PrismaClient,
  ) {}

  /**
   * @param id - The unique identifier of the project.
   * @returns The project if found, null otherwise.
   */
  async findById(id: ProjectId): Promise<Project | null> {
    const record = await this.prisma.project.findUnique({ where: { id: id.value } });
    return record ? toDomainProject(record) : null;
  }

  /**
   * Finds all projects where the user is a member.
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
    const where: Record<string, unknown> = {
      members: { some: { userId: userId.value } },
      archivedAt: archivedOnly ? { not: null } : null,
    };

    const [records, total] = await Promise.all([
      this.prisma.project.findMany({
        where,
        skip: (pagination.page - 1) * pagination.limit,
        take: pagination.limit,
        orderBy: { updatedAt: 'desc' },
      }),
      this.prisma.project.count({ where }),
    ]);
    return {
      projects: records.map(toDomainProject),
      total,
      page: pagination.page,
      limit: pagination.limit,
      totalPages: Math.ceil(total / pagination.limit),
    };
  }

  /**
   * Creates or updates a project. Uses upsert so the same method
   * handles both insert and update.
   * 
   * @param project - The project entity to persist.
   */
  async save(project: Project): Promise<void> {
    const data = toPersistenceProject(project);
    await this.prisma.project.upsert({
      where: { id: project.id.value },
      create: data,
      update: data,
    });
  }

  /**
   * Archives a project by setting archivedAt timestamp.
   *
   * @param id - The unique identifier of the project to archive.
   * @param archivedAt - The archive timestamp.
   */
  async archive(id: ProjectId, archivedAt: Date): Promise<void> {
    await this.prisma.project.update({
      where: { id: id.value },
      data: { archivedAt },
    });
  }

  /**
   * Restores an archived project by setting archivedAt to null.
   *
   * @param id - The unique identifier of the project to restore.
   */
  async restore(id: ProjectId): Promise<void> {
    await this.prisma.project.update({
      where: { id: id.value },
      data: { archivedAt: null },
    });
  }

  /**
   * @param id - The unique identifier of the project to delete.
   */
  async delete(id: ProjectId): Promise<void> {
    await this.prisma.project.deleteMany({ where: { id: id.value } });
  }
}

function toDomainProject(record: {
  id: string; name: string; description: string | null;
  tags: unknown; archivedAt: Date | null; mainFileNodeId?: string | null; language?: string | null;
  gitIgnorePatterns?: string | null; createdAt: Date; updatedAt: Date;
}): Project {
  return new Project(
    ProjectId.create(record.id),
    ProjectName.create(record.name),
    record.description,
    Array.isArray(record.tags) ? record.tags.filter((t): t is string => typeof t === 'string') : [],
    null,
    new Timestamps(record.createdAt, record.updatedAt),
    record.archivedAt,
    record.mainFileNodeId ? FileNodeId.create(record.mainFileNodeId) : null,
    // A corrupt/unknown stored language must not break loading — treat it as unset.
    record.language && isSpellcheckLanguage(record.language) ? record.language : null,
    record.gitIgnorePatterns ?? null,
  );
}

function toPersistenceProject(project: Project): {
  id: string; name: string; description: string | null;
  tags: string[]; mainFileNodeId: string | null; language: string | null; gitIgnorePatterns: string | null;
  createdAt: Date; updatedAt: Date;
} {
  return {
    id: project.id.value,
    name: project.name.value,
    description: project.description,
    tags: [...project.tags],
    mainFileNodeId: project.mainFileNodeId?.value ?? null,
    language: project.language,
    gitIgnorePatterns: project.gitIgnorePatterns,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
  };
}
