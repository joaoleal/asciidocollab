import type { PrismaClient } from '@prisma/client';
import {
  PrismaUserRepository,
  PrismaProjectRepository,
  PrismaFileNodeRepository,
  PrismaDocumentRepository,
  PrismaProjectMemberRepository,
  PrismaGitRepositoryRepository,
  PrismaTemplateRepository,
  PrismaAssetRepository,
  PrismaAuditLogRepository,
  PrismaAuthAttemptTelemetryRepository,
  PrismaPasswordResetTokenRepository,
  PrismaEmailChangeTokenRepository,
  PrismaUserInvitationRepository,
  PrismaEmailVerificationTokenRepository,
  PrismaSystemSettingRepository,
  PrismaSessionRepository,
  PrismaKeyBindingRepository,
  PrismaEditorPreferencesRepository,
  PrismaCollaborationSessionRepository,
  PrismaReviewCommentRepository,
  PrismaReviewReactionRepository,
  PrismaProjectRenderConfigRepository,
  PrismaProjectDictionaryRepository,
  PrismaIgnoredLintRepository,
} from '@asciidocollab/infrastructure';
import type { AppContainer } from '..';

/**
 * Instantiates the full set of Prisma-backed domain repositories.
 *
 * @param prisma - The Prisma client used to construct each repository.
 * @returns The repository container decorated onto the Fastify instance.
 */
export function createRepositories(prisma: PrismaClient): AppContainer['repos'] {
  return {
    user: new PrismaUserRepository(prisma),
    project: new PrismaProjectRepository(prisma),
    fileNode: new PrismaFileNodeRepository(prisma),
    document: new PrismaDocumentRepository(prisma),
    projectMember: new PrismaProjectMemberRepository(prisma),
    gitRepository: new PrismaGitRepositoryRepository(prisma),
    template: new PrismaTemplateRepository(prisma),
    asset: new PrismaAssetRepository(prisma),
    auditLog: new PrismaAuditLogRepository(prisma),
    authAttemptTelemetry: new PrismaAuthAttemptTelemetryRepository(prisma),
    passwordResetToken: new PrismaPasswordResetTokenRepository(prisma),
    emailChangeToken: new PrismaEmailChangeTokenRepository(prisma),
    userInvitation: new PrismaUserInvitationRepository(prisma),
    emailVerificationToken: new PrismaEmailVerificationTokenRepository(prisma),
    systemSetting: new PrismaSystemSettingRepository(prisma),
    session: new PrismaSessionRepository(prisma),
    keyBinding: new PrismaKeyBindingRepository(prisma),
    editorPreferences: new PrismaEditorPreferencesRepository(prisma),
    collaborationSession: new PrismaCollaborationSessionRepository(prisma),
    reviewComment: new PrismaReviewCommentRepository(prisma),
    reviewReaction: new PrismaReviewReactionRepository(prisma),
    projectRenderConfig: new PrismaProjectRenderConfigRepository(prisma),
    projectDictionary: new PrismaProjectDictionaryRepository(prisma),
    ignoredLint: new PrismaIgnoredLintRepository(prisma),
  };
}
