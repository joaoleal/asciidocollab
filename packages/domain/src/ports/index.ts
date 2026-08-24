/** @file Barrel re-exports for all domain port interfaces. */

// user/
export type { UserRepository } from './user/user.repository';
export type { SessionRepository } from './user/session.repository';
export type { KeyBindingRepository } from './user/key-binding.repository';
export type { UserInvitationRepository } from './user/user-invitation.repository';
export type { EditorPreferencesRepository } from './user/editor-preferences.repository';

// project/
export type { ProjectRepository, PaginationParameters, PaginatedProjects } from './project/project.repository';
export type { ProjectMemberRepository } from './project/project-member.repository';
export type { ProjectDictionaryRepository } from './grammar/project-dictionary.repository';
export type { IgnoredLintRepository } from './grammar/ignored-lint.repository';
export type { TemplateRepository } from './project/template.repository';
export type { GitRepositoryRepository } from './project/git-repository.repository';
export type { CollaborationSessionRepository } from './project/collaboration-session.repository';
export type { ProjectRenderConfigRepository } from './project/project-render-config.repository';
export type { ActiveCloneRegistry } from './project/active-clone-registry';

// git/
export type { GitCredentialStore, GitCredentialRecord } from './git/git-credential-store';
export type {
  GitOperationRepository,
  EnqueueGitOperationInput,
  CreateGitConflictInput,
} from './git/git-operation-repository';
export type {
  GitCommandRunner,
  GitWorkingTreeStatus,
  GitPendingChange,
  GitPendingChangeType,
} from './git/git-command-runner';

// file-tree/
export type { FileNodeRepository } from './file-tree/file-node.repository';
export type { DocumentRepository } from './file-tree/document.repository';
export type { AssetRepository } from './file-tree/asset.repository';

// storage/
export type { ProjectFileStore } from './storage/project-file-store';
export type { YjsStateStore } from './storage/yjs-state-store';
export type { CollaborativeContentEditor, ContentReplacement } from './storage/collaborative-content-editor';
export type { CollaborativeContentReader } from './storage/collaborative-content-reader';
export type { StructuredCollaborativeEditor, StructuredReplacementSpec } from './storage/structured-collaborative-editor';

// text/
export type { RegexEngine, RegexFlags, MatchBudget, MatchSpan, CompiledMatcher } from './text/regex-engine';

// auth-tokens/
export type { EmailChangeTokenRepository } from './auth-tokens/email-change-token.repository';
export type { EmailVerificationTokenRepository } from './auth-tokens/email-verification-token.repository';
export type { PasswordResetTokenRepository } from './auth-tokens/password-reset-token.repository';

// admin/
export type { AuditLogRepository, AuditLogFilters, PaginationOptions, PagedResult } from './admin/audit-log.repository';
export type { AuthAttemptTelemetryRepository, AuthAttemptTelemetryFilters, RecordAuthAttemptInput } from './admin/auth-attempt-telemetry.repository';
export type { SystemSettingRepository } from './admin/system-setting.repository';

// observability/
export type { Logger } from './observability/logger';

// review/
export type { ReviewCommentRepository, ListByDocumentOptions, ListByProjectFilters } from './review/review-comment.repository';
export type { ReviewReactionRepository } from './review/review-reaction.repository';

// pdf-extensions/
export type {
  PdfExtensionSourcePort,
  PdfExtensionListing,
  DiscoveredPdfExtension,
  ExcludedPdfExtension,
} from './pdf-extensions/pdf-extension-source.port';
