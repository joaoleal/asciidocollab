import type { PrismaClient } from '@prisma/client';
import {
  ProjectDictionaryTerm,
  ProjectDictionaryTermId,
  ProjectId,
  UserId,
} from '@asciidocollab/domain';
import type { ProjectDictionaryRepository } from '@asciidocollab/domain';

/** The persisted shape of a project-dictionary-term row. */
interface ProjectDictionaryTermRow {
  id: string;
  projectId: string;
  term: string;
  createdByUserId: string;
  createdAt: Date;
}

/** Prisma-backed implementation of ProjectDictionaryRepository. */
export class PrismaProjectDictionaryRepository implements ProjectDictionaryRepository {
  /** @param prisma - The Prisma client instance. */
  constructor(private readonly prisma: PrismaClient) {}

  /** @inheritdoc */
  async listByProject(projectId: ProjectId): Promise<ProjectDictionaryTerm[]> {
    const rows = await this.prisma.projectDictionaryTerm.findMany({
      where: { projectId: projectId.value },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((row) => this.toDomain(row));
  }

  /** @inheritdoc */
  async findByTerm(projectId: ProjectId, term: string): Promise<ProjectDictionaryTerm | null> {
    // Case-insensitive match so `API` and `api` are the same term (the @@unique is exact, so the app
    // layer owns case-folding — see the AddDictionaryTerm use case's idempotent dedupe).
    const row = await this.prisma.projectDictionaryTerm.findFirst({
      where: { projectId: projectId.value, term: { equals: term, mode: 'insensitive' } },
    });
    return row ? this.toDomain(row) : null;
  }

  /** @inheritdoc */
  async add(term: ProjectDictionaryTerm): Promise<void> {
    await this.prisma.projectDictionaryTerm.create({
      data: {
        id: term.id.value,
        projectId: term.projectId.value,
        term: term.term,
        createdByUserId: term.createdByUserId.value,
        createdAt: term.createdAt,
      },
    });
  }

  /** @inheritdoc */
  async removeById(projectId: ProjectId, id: ProjectDictionaryTermId): Promise<boolean> {
    const result = await this.prisma.projectDictionaryTerm.deleteMany({
      where: { id: id.value, projectId: projectId.value },
    });
    return result.count > 0;
  }

  private toDomain(row: ProjectDictionaryTermRow): ProjectDictionaryTerm {
    return new ProjectDictionaryTerm(
      ProjectDictionaryTermId.create(row.id),
      ProjectId.create(row.projectId),
      row.term,
      UserId.create(row.createdByUserId),
      row.createdAt,
    );
  }
}
