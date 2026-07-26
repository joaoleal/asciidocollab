import type { PrismaClient } from '@prisma/client';
import { IgnoredLint, IgnoredLintId, UserId, FileNodeId } from '@asciidocollab/domain';
import type { IgnoredLintRepository } from '@asciidocollab/domain';

/** The persisted shape of an ignored-lint row. */
interface IgnoredLintRow {
  id: string;
  userId: string;
  documentId: string;
  ignoredLintsJson: string;
  updatedAt: Date;
}

/** Prisma-backed implementation of IgnoredLintRepository. */
export class PrismaIgnoredLintRepository implements IgnoredLintRepository {
  /** @param prisma - The Prisma client instance. */
  constructor(private readonly prisma: PrismaClient) {}

  /** @inheritdoc */
  async findByUserAndDocument(userId: UserId, documentId: FileNodeId): Promise<IgnoredLint | null> {
    const row = await this.prisma.ignoredLint.findUnique({
      where: { userId_documentId: { userId: userId.value, documentId: documentId.value } },
    });
    return row ? this.toDomain(row) : null;
  }

  /** @inheritdoc */
  async upsert(record: IgnoredLint): Promise<void> {
    await this.prisma.ignoredLint.upsert({
      where: { userId_documentId: { userId: record.userId.value, documentId: record.documentId.value } },
      update: { ignoredLintsJson: record.ignoredLintsJson },
      create: {
        id: record.id.value,
        userId: record.userId.value,
        documentId: record.documentId.value,
        ignoredLintsJson: record.ignoredLintsJson,
      },
    });
  }

  private toDomain(row: IgnoredLintRow): IgnoredLint {
    return new IgnoredLint(
      IgnoredLintId.create(row.id),
      UserId.create(row.userId),
      FileNodeId.create(row.documentId),
      row.ignoredLintsJson,
      row.updatedAt,
    );
  }
}
