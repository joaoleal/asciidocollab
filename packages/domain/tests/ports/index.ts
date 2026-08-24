/** @file Barrel re-exports for all in-memory port fakes used in tests. */

// user/
export { InMemoryUserRepository } from './user/in-memory-user.repository';
export { InMemorySessionRepository } from './user/in-memory-session.repository';
export { InMemoryKeyBindingRepository } from './user/in-memory-key-binding.repository';
export { InMemoryUserInvitationRepository } from './user/in-memory-user-invitation.repository';

// project/
export { InMemoryProjectRepository } from './project/in-memory-project.repository';
export { InMemoryProjectMemberRepository } from './project/in-memory-project-member.repository';
export { InMemoryTemplateRepository } from './project/in-memory-template.repository';
export { InMemoryGitRepositoryRepository } from './project/in-memory-git-repository.repository';
export { InMemoryActiveCloneRegistry } from './project/in-memory-active-clone-registry';

// git/
export { InMemoryGitCredentialStore } from './git/in-memory-git-credential-store';
export { InMemoryGitOperationRepository } from './git/in-memory-git-operation-repository';
export type { Clock } from './git/in-memory-git-operation-repository';

// file-tree/
export { InMemoryFileNodeRepository } from './file-tree/in-memory-file-node.repository';
export { InMemoryDocumentRepository } from './file-tree/in-memory-document.repository';
export { InMemoryAssetRepository } from './file-tree/in-memory-asset.repository';

// storage/
export { InMemoryProjectFileStore } from './storage/in-memory-project-file-store';
export { InMemoryYjsStateStore } from './storage/in-memory-yjs-state-store';
export { InMemoryStructuredCollaborativeEditor } from './storage/in-memory-structured-collaborative-editor';

// text/
export { InMemoryRegexEngine } from './text/in-memory-regex-engine';

// auth-tokens/
export { InMemoryEmailChangeTokenRepository } from './auth-tokens/in-memory-email-change-token.repository';
export { InMemoryEmailVerificationTokenRepository } from './auth-tokens/in-memory-email-verification-token.repository';
export { InMemoryPasswordResetTokenRepository } from './auth-tokens/in-memory-password-reset-token.repository';

// admin/
export { InMemoryAuditLogRepository } from './admin/in-memory-audit-log.repository';
export { InMemorySystemSettingRepository } from './admin/in-memory-system-setting.repository';

// review/
export { InMemoryReviewCommentRepository } from './review/in-memory-review-comment.repository';
export { InMemoryReviewReactionRepository } from './review/in-memory-review-reaction.repository';

// project/
export { InMemoryProjectRenderConfigRepository } from './project/in-memory-project-render-config.repository';
