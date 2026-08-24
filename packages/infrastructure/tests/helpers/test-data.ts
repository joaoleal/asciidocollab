import { randomUUID } from 'crypto';
import { PrismaClient } from '@prisma/client';
import { User, UserId, Email, Project, ProjectId, ProjectName, ProjectMember, Role, FileNode, FileNodeId, FileNodeType, FilePath, Document, DocumentId, ContentId, YjsStateId, MimeType, Asset, Template, TemplateId, TemplateCategory, GitRepository, GitRepositoryId, GitProvider, AuditLog, AuditLogId, Timestamps } from '@asciidocollab/domain';
import type { RegistrationMethod, GitSyncStatus } from '@asciidocollab/domain';

type UserOverrides = Partial<{ id?: UserId; email?: Email; displayName?: string; passwordHash?: string | null; passwordHistory?: string[]; samlSubject?: string | null; mfaSecret?: string | null; isAdmin?: boolean; timestamps?: Timestamps; emailVerified?: boolean; registrationMethod?: RegistrationMethod }>;

function value<T>(overrides: UserOverrides | undefined, key: string, definition: T): T {
  if (overrides && key in overrides) return (overrides as Record<string, unknown>)[key] as T;
  return definition;
}

export function createTestUser(overrides?: UserOverrides): User {
  const id = overrides?.id ?? UserId.create(randomUUID());
  const email = overrides?.email ?? Email.create(`test-${Date.now()}@example.com`);
  return new User(
    id,
    email,
    value(overrides, 'displayName', 'Test User'),
    value<string | null>(overrides, 'passwordHash', 'hashed_password'),
    value<string[]>(overrides, 'passwordHistory', []),
    value<string | null>(overrides, 'samlSubject', null),
    value<string | null>(overrides, 'mfaSecret', null),
    overrides?.isAdmin ?? false,
    overrides?.timestamps ?? new Timestamps(),
    overrides?.emailVerified ?? true,
    overrides?.registrationMethod ?? 'SELF_REGISTERED',
  );
}

export function createTestProject(overrides?: { id?: ProjectId; name?: ProjectName; description?: string | null; tags?: string[]; rootFolderId?: FileNodeId | null; timestamps?: Timestamps }): Project {
  return new Project(
    overrides?.id ?? ProjectId.create(randomUUID()),
    overrides?.name ?? ProjectName.create('Test Project'),
    overrides?.description ?? null,
    overrides?.tags ?? [],
    overrides?.rootFolderId ?? null,
    overrides?.timestamps ?? new Timestamps(),
  );
}

export function createTestProjectMember(projectId: ProjectId, userId: UserId, overrides?: { role?: Role; joinedAt?: Date }): ProjectMember {
  return new ProjectMember(
    projectId,
    userId,
    overrides?.role ?? Role.create('viewer'),
    overrides?.joinedAt ?? new Date(),
  );
}

export function createTestFileNode(projectId: ProjectId, overrides?: { id?: FileNodeId; parentId?: FileNodeId | null; name?: string; type?: FileNodeType; path?: FilePath; timestamps?: Timestamps }): FileNode {
  return new FileNode(
    overrides?.id ?? FileNodeId.create(randomUUID()),
    projectId,
    overrides?.parentId ?? null,
    overrides?.name ?? 'test-file.adoc',
    overrides?.type ?? FileNodeType.create('file'),
    overrides?.path ?? FilePath.create('/test-file.adoc'),
    overrides?.timestamps ?? new Timestamps(),
  );
}

export function createTestDocument(fileNodeId: FileNodeId, overrides?: { id?: DocumentId; contentId?: ContentId; yjsStateId?: YjsStateId; mimeType?: MimeType; timestamps?: Timestamps }): Document {
  const contentId = overrides?.contentId ?? ContentId.create(randomUUID());
  const yjsStateId = overrides?.yjsStateId ?? YjsStateId.create(randomUUID());
  return new Document(
    overrides?.id ?? DocumentId.create(randomUUID()),
    fileNodeId,
    contentId,
    yjsStateId,
    overrides?.mimeType ?? MimeType.create('text/asciidoc'),
    overrides?.timestamps ?? new Timestamps(),
  );
}

export function createTestAsset(fileNodeId: FileNodeId, overrides?: { mimeType?: MimeType; sizeBytes?: bigint; uploadedAt?: Date; updatedAt?: Date | null }): Asset {
  return new Asset(
    fileNodeId,
    overrides?.mimeType ?? MimeType.create('image/png'),
    overrides?.sizeBytes ?? 1024n,
    overrides?.uploadedAt ?? new Date(),
    overrides?.updatedAt ?? null,
  );
}

export function createTestTemplate(overrides?: { id?: TemplateId; name?: string; description?: string | null; category?: TemplateCategory; sourceProjectId?: ProjectId | null; createdAt?: Date }): Template {
  return new Template(
    overrides?.id ?? TemplateId.create(randomUUID()),
    overrides?.name ?? 'Test Template',
    overrides?.description ?? null,
    overrides?.category ?? TemplateCategory.create('documentation'),
    overrides?.sourceProjectId ?? null,
    overrides?.createdAt ?? new Date(),
  );
}

export function createTestGitRepository(projectId: ProjectId, overrides?: { id?: GitRepositoryId; provider?: GitProvider; remoteUrl?: string; credentialReference?: string; currentBranch?: string; syncStatus?: GitSyncStatus; defaultBranch?: string | null; lastKnownRemoteHead?: string | null; lastSyncAt?: Date | null; createdAt?: Date }): GitRepository {
  return new GitRepository(
    overrides?.id ?? GitRepositoryId.create(randomUUID()),
    projectId,
    overrides?.provider ?? GitProvider.create('github'),
    overrides?.remoteUrl ?? 'https://github.com/test/repo.git',
    overrides?.credentialReference ?? 'cred-123',
    overrides?.currentBranch ?? 'main',
    overrides?.syncStatus ?? 'UP_TO_DATE',
    overrides?.defaultBranch ?? null,
    overrides?.lastKnownRemoteHead ?? null,
    overrides?.lastSyncAt ?? null,
    overrides?.createdAt ?? new Date(),
  );
}

/** Fields accepted when building a review-comment row directly via Prisma. */
export type ReviewCommentRowOverrides = {
  id?: string;
  projectId: string;
  documentId: string;
  authorId?: string | null;
  parentId?: string | null;
  kind?: 'COMMENT' | 'TASK';
  body?: string;
  status?: 'OPEN' | 'IN_PROGRESS' | 'RESOLVED' | 'WONTFIX' | null;
  assigneeId?: string | null;
  dueDate?: Date | null;
  resolvedAt?: Date | null;
  resolvedById?: string | null;
  anchorQuoteExact?: string | null;
  anchorSectionId?: string | null;
  anchorState?: 'LOCATED' | 'SECTION' | 'DETACHED';
};

/**
 * Inserts a root ReviewComment row (kind COMMENT by default) and returns the
 * persisted record. Pass `parentId` to insert a reply (its anchor stays null).
 */
export async function createTestReviewComment(prisma: PrismaClient, overrides: ReviewCommentRowOverrides) {
  const isReply = (overrides.parentId ?? null) !== null;
  return prisma.reviewComment.create({
    data: {
      id: overrides.id ?? randomUUID(),
      projectId: overrides.projectId,
      documentId: overrides.documentId,
      parentId: overrides.parentId ?? null,
      kind: overrides.kind ?? 'COMMENT',
      body: overrides.body ?? 'A review comment',
      authorId: 'authorId' in overrides ? overrides.authorId ?? null : null,
      status: overrides.status ?? null,
      assigneeId: overrides.assigneeId ?? null,
      dueDate: overrides.dueDate ?? null,
      resolvedAt: overrides.resolvedAt ?? null,
      resolvedById: overrides.resolvedById ?? null,
      anchorQuoteExact: isReply ? null : overrides.anchorQuoteExact ?? 'the quoted passage',
      anchorSectionId: isReply ? null : overrides.anchorSectionId ?? null,
      anchorState: overrides.anchorState ?? 'LOCATED',
    },
  });
}

export function createTestAuditLog(userId: UserId, overrides?: { id?: AuditLogId; projectId?: ProjectId | null; action?: string; resourceType?: string; resourceId?: string; timestamp?: Date; metadata?: Record<string, unknown> }): AuditLog {
  return new AuditLog(
    overrides?.id ?? AuditLogId.create(randomUUID()),
    userId,
    overrides?.projectId ?? null,
    overrides?.action ?? 'test.action',
    overrides?.resourceType ?? 'test',
    overrides?.resourceId ?? 'res-123',
    overrides?.timestamp ?? new Date(),
    overrides?.metadata ?? {},
  );
}
