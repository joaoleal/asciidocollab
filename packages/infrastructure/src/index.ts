/**
 * @packageDocumentation Barrel file for the infrastructure package.
 */

// user/
export { PrismaUserRepository } from './persistence/user/prisma-user.repository';
export { PrismaSessionRepository } from './persistence/user/prisma-session.repository';
export { PrismaKeyBindingRepository } from './persistence/user/prisma-key-binding.repository';
export { PrismaUserInvitationRepository } from './persistence/user/prisma-user-invitation.repository';

// project/
export { PrismaProjectRepository } from './persistence/project/prisma-project.repository';
export { PrismaProjectMemberRepository } from './persistence/project/prisma-project-member.repository';
export { PrismaTemplateRepository } from './persistence/project/prisma-template.repository';
export { PrismaGitRepositoryRepository } from './persistence/project/prisma-git-repository.repository';

// git/
export { PrismaGitOperationRepository, type PrismaGitOperationRepositoryOptions } from './persistence/git/prisma-git-operation.repository';
export { PrismaGitCredentialStore, type DecryptedGitCredential } from './persistence/git/prisma-git-credential-store';
export { PrismaCollaborationSessionRepository } from './persistence/project/prisma-collaboration-session-repository';
export { PrismaProjectRenderConfigRepository } from './persistence/project/prisma-project-render-config.repository';
export { PrismaProjectDictionaryRepository } from './persistence/grammar/prisma-project-dictionary.repository';
export { PrismaIgnoredLintRepository } from './persistence/grammar/prisma-ignored-lint.repository';

// file-tree/
export { PrismaFileNodeRepository } from './persistence/file-tree/prisma-file-node.repository';
export { PrismaDocumentRepository } from './persistence/file-tree/prisma-document.repository';
export { PrismaAssetRepository } from './persistence/file-tree/prisma-asset.repository';

// review/
export { PrismaReviewCommentRepository } from './persistence/review/prisma-review-comment.repository';
export { PrismaReviewReactionRepository } from './persistence/review/prisma-review-reaction.repository';

// storage/
export { FilesystemProjectFileStore } from './persistence/storage/filesystem-project-file-store';
export { FilesystemYjsStateStore } from './persistence/storage/filesystem-yjs-state-store';

// auth-tokens/
export { PrismaEmailChangeTokenRepository } from './persistence/auth-tokens/prisma-email-change-token.repository';
export { PrismaEmailVerificationTokenRepository } from './persistence/auth-tokens/prisma-email-verification-token.repository';
export { PrismaPasswordResetTokenRepository } from './persistence/auth-tokens/prisma-password-reset-token.repository';

// admin/
export { PrismaAuditLogRepository } from './persistence/admin/prisma-audit-log.repository';
export { PrismaAuthAttemptTelemetryRepository } from './persistence/admin/prisma-auth-attempt-telemetry.repository';
export { PrismaSystemSettingRepository } from './persistence/admin/prisma-system-setting.repository';

export * from './services';
export { PrismaEditorPreferencesRepository } from './persistence/user/prisma-editor-preferences.repository';
export {
  FilesystemPdfExtensionSource,
  type FilesystemPdfExtensionSourceOptions,
} from './persistence/pdf-extensions/filesystem-pdf-extension-source';
