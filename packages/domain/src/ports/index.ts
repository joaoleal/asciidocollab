/** @file Barrel re-exports for all domain port interfaces. */

// user/
export { UserRepository } from './user/user.repository';
export { SessionRepository } from './user/session.repository';
export { KeyBindingRepository } from './user/key-binding.repository';
export { UserInvitationRepository } from './user/user-invitation.repository';
export type { EditorPreferencesRepository } from './user/editor-preferences.repository';

// project/
export { ProjectRepository, PaginationParameters, PaginatedProjects } from './project/project.repository';
export { ProjectMemberRepository } from './project/project-member.repository';
export { TemplateRepository } from './project/template.repository';
export { GitRepositoryRepository } from './project/git-repository.repository';
export { CollaborationSessionRepository } from './project/collaboration-session.repository';
export { ProjectRenderConfigRepository } from './project/project-render-config.repository';

// file-tree/
export { FileNodeRepository } from './file-tree/file-node.repository';
export { DocumentRepository } from './file-tree/document.repository';
export { AssetRepository } from './file-tree/asset.repository';

// storage/
export { ProjectFileStore } from './storage/project-file-store';
export { YjsStateStore } from './storage/yjs-state-store';
export { CollaborativeContentEditor, ContentReplacement } from './storage/collaborative-content-editor';
export { CollaborativeContentReader } from './storage/collaborative-content-reader';
export { StructuredCollaborativeEditor, StructuredReplacementSpec } from './storage/structured-collaborative-editor';

// text/
export { RegexEngine, RegexFlags, MatchBudget, MatchSpan, CompiledMatcher } from './text/regex-engine';

// auth-tokens/
export { EmailChangeTokenRepository } from './auth-tokens/email-change-token.repository';
export { EmailVerificationTokenRepository } from './auth-tokens/email-verification-token.repository';
export { PasswordResetTokenRepository } from './auth-tokens/password-reset-token.repository';

// admin/
export { AuditLogRepository, AuditLogFilters, PaginationOptions, PagedResult } from './admin/audit-log.repository';
export { AuthAttemptTelemetryRepository, AuthAttemptTelemetryFilters, RecordAuthAttemptInput } from './admin/auth-attempt-telemetry.repository';
export { SystemSettingRepository } from './admin/system-setting.repository';

// observability/
export { Logger } from './observability/logger';

// review/
export {
  ReviewCommentRepository,
  ListByDocumentOptions,
  ListByProjectFilters,
} from './review/review-comment.repository';
export { ReviewReactionRepository } from './review/review-reaction.repository';

// pdf-extensions/
export type {
  PdfExtensionSourcePort,
  PdfExtensionListing,
  DiscoveredPdfExtension,
  ExcludedPdfExtension,
} from './pdf-extensions/pdf-extension-source.port';
