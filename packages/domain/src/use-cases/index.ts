/** @file Barrel re-exports for all domain use cases. */
export { CreateProjectUseCase } from './project/create-project';
export { RenameFileUseCase } from './file-tree/rename-file';
export { DeleteFileUseCase } from './file-tree/delete-file';
export { InviteUserUseCase } from './auth/invite-user';
export { RemoveMemberUseCase } from './members/remove-member';
export { ChangeMemberRoleUseCase } from './members/change-member-role';
export { GetProjectTreeUseCase } from './file-tree/get-project-tree';
export { RegisterUserUseCase } from './auth/register-user';
export { ResetPasswordUseCase } from './auth/reset-password';
export { ChangePasswordUseCase } from './auth/change-password';
export { RequestPasswordResetUseCase } from './auth/request-password-reset';
export { LoginUseCase } from './auth/login';
export { LogoutUseCase } from './auth/logout';
export { ListUserProjectsUseCase } from './project/list-user-projects';
export { UpdateProjectUseCase } from './project/update-project';
export { SetProjectMainFileUseCase } from './project/set-project-main-file';
export type { SetProjectMainFileInput } from './project/set-project-main-file';
export { ArchiveProjectUseCase } from './project/archive-project';
export { RestoreProjectUseCase } from './project/restore-project';
export { GetProjectGitIgnorePatternsUseCase } from './project/get-project-git-ignore-patterns';
export type { GitIgnorePatternsResult } from './project/get-project-git-ignore-patterns';
export { SaveProjectGitIgnorePatternsUseCase } from './project/save-project-git-ignore-patterns';
export {
  requireGitIgnorePatternsOwner,
  GIT_IGNORE_PATTERNS_RESOURCE_TYPE,
} from './project/git-ignore-patterns-authorization';
export type { GitIgnorePatternsAuthzContext } from './project/git-ignore-patterns-authorization';
export { requireGitRole, GIT_RESOURCE_TYPE } from './git/git-role-guard';
export type { GitRoleAuthzContext, GitRoleTier } from './git/git-role-guard';
export { ConnectRepositoryUseCase } from './git/connect-repository';
export type { ConnectRepositoryInput, ConnectRepositoryResult } from './git/connect-repository';
export { ImportRepositoryUseCase } from './git/import-repository';
export type { ImportRepositoryInput, ImportRepositoryResult } from './git/import-repository';
export { InitializeRepositoryUseCase } from './git/initialize-repository';
export type { InitializeRepositoryInput, InitializeRepositoryResult } from './git/initialize-repository';
export { DisconnectRepositoryUseCase } from './git/disconnect-repository';
export type { DisconnectRepositoryInput, DisconnectRepositoryResult } from './git/disconnect-repository';
export { GetGitStatusUseCase } from './git/get-git-status';
export type { GetGitStatusInput, GetGitStatusResult } from './git/get-git-status';
export { CreateBranchUseCase } from './git/create-branch';
export type { CreateBranchInput, CreateBranchResult } from './git/create-branch';
export { GetBranchesUseCase } from './git/get-branches';
export type { GetBranchesInput, GetBranchesResult } from './git/get-branches';
export { StageChangesUseCase } from './git/stage-changes';
export type { StageChangesAction, StageChangesInput, StageChangesResult } from './git/stage-changes';
export { CommitChangesUseCase } from './git/commit-changes';
export type { CommitChangesInput, CommitChangesResult } from './git/commit-changes';
export { PushChangesUseCase } from './git/push-changes';
export type { PushChangesInput, PushChangesResult } from './git/push-changes';
export { PullChangesUseCase } from './git/pull-changes';
export type { PullChangesInput, PullChangesResult, FileChangeReconciler } from './git/pull-changes';
export { SwitchBranchUseCase } from './git/switch-branch';
export type { SwitchBranchInput, SwitchBranchResult } from './git/switch-branch';
export { GitChangeReconciler } from './git/git-change-reconciler';
export type { GitChangeReconcileResult } from './git/git-change-reconciler';
export { GetBehindAheadUseCase } from './git/get-behind-ahead';
export type { GetBehindAheadInput } from './git/get-behind-ahead';
export { RefreshRemoteStatusUseCase } from './git/refresh-remote-status';
export type { RefreshRemoteStatusInput, RefreshRemoteStatusResult } from './git/refresh-remote-status';
export { ResolveConflictsUseCase } from './git/resolve-conflicts';
export type { ResolveConflictsInput, ResolveConflictsResult } from './git/resolve-conflicts';
export { GetConflictStagesUseCase } from './git/get-conflict-stages';
export type { GetConflictStagesInput, GetConflictStagesResult } from './git/get-conflict-stages';
export { ListConflictsUseCase } from './git/list-conflicts';
export type { ListConflictsInput, ListConflictsResult, ConflictSummary } from './git/list-conflicts';
export { CompleteMergeUseCase } from './git/complete-merge';
export type { CompleteMergeInput, CompleteMergeResult } from './git/complete-merge';
export { UndoPullUseCase } from './git/undo-pull';
export type { UndoPullInput, UndoPullResult } from './git/undo-pull';
export { GetHistoryUseCase } from './git/get-history';
export type { GetHistoryInput, GetHistoryResult, HistoryCommit } from './git/get-history';
export { GetDiffUseCase } from './git/get-diff';
export type { GetDiffInput, GetDiffResult } from './git/get-diff';
export { GetBlameUseCase } from './git/get-blame';
export type { GetBlameInput, GetBlameResult, BlameLine } from './git/get-blame';
export { CheckSystemSetupUseCase } from './settings/check-system-setup';
export { UpdateDisplayNameUseCase } from './auth/update-display-name';
export type { UpdateDisplayNameResult } from './auth/update-display-name';
export { RequestEmailChangeUseCase } from './auth/request-email-change';
export { ConfirmEmailChangeUseCase } from './auth/confirm-email-change';
export type { ConfirmEmailChangeResult } from './auth/confirm-email-change';
export { DeleteProjectUseCase } from './project/delete-project';
export { CloneProjectUseCase } from './project/clone-project';
export type { CloneProjectResult } from './project/clone-project';
export { SendUserInvitationUseCase } from './auth/send-user-invitation';
export { AcceptUserInvitationUseCase } from './auth/accept-user-invitation';
export type { AcceptUserInvitationResult } from './auth/accept-user-invitation';
export { VerifyEmailUseCase } from './auth/verify-email';
export type { VerifyEmailResult } from './auth/verify-email';
export { ResendVerificationEmailUseCase } from './auth/resend-verification-email';
export { RegisterUseCase } from './auth/register-user';
export type { RegisterUserResult } from './auth/register-user';
export { ListUsersUseCase } from './auth/list-users';
export { SetAdminStatusUseCase } from './settings/set-admin-status';
export { RemoveUserUseCase } from './auth/remove-user';
export type { RemoveUserResult } from './auth/remove-user';
export { GetOpenRegistrationUseCase, SetOpenRegistrationUseCase } from './settings/get-open-registration';
export { GetMaxUploadSizeUseCase, SetMaxUploadSizeUseCase } from './settings/admin-max-upload-size';
export { GetDocumentContentUseCase } from './content/get-document-content';
export { GetDocumentCollabInfoUseCase } from './content/get-document-collab-info';
export type { DocumentCollabInfo, CollabRole } from './content/get-document-collab-info';
export { toCollabRole } from './content/collab-role';
export { AuthorizeCollabConnectionUseCase } from './content/authorize-collab-connection';
export type { CollabConnectionAuthorization } from './content/authorize-collab-connection';
export { AuthorizeProjectPresenceUseCase } from './content/authorize-project-presence';
export { GetFileNodeContentUseCase } from './content/get-file-node-content';
export type { FileNodeContent } from './content/get-file-node-content';
export { SaveDocumentContentUseCase } from './content/save-document-content';
export { CreateFileUseCase } from './file-tree/create-file';
export { CreateFolderUseCase } from './file-tree/create-folder';
export { MoveFileUseCase } from './file-tree/move-file';
export { FindReferencesUseCase } from './content/find-references';
export type { ReferenceUsage } from './content/find-references';
export { RenameSymbolUseCase } from './content/rename-symbol';
export type { RenameSymbolInput, RenameSymbolOutcome, RenamableSymbolKind } from './content/rename-symbol';
export { computeMatches, substitute, selectSpans } from './content/text-match';
export type { SearchQuery, SearchMode, ReplaceSelection, PositionalEdit } from './content/text-match';
export { SearchProjectContentUseCase } from './content/search-project-content';
export type {
  SearchMatch,
  FileMatchGroup,
  SearchResult,
  SearchLimits,
  SearchProjectContentInput,
} from './content/search-project-content';
export { ReplaceProjectContentUseCase } from './content/replace-project-content';
export type {
  ReplaceScope,
  FileReplaceSelection,
  ReplaceOutcome,
  ReplaceSkipReason,
  ReplaceProjectContentInput,
} from './content/replace-project-content';
export { isAsciiDocumentFileName } from '../value-objects/files/asciidoc-file-name';
export { UploadAssetUseCase } from './content/upload-asset';
export { GetAssetContentUseCase } from './content/get-asset-content';
export { GetAssetContentByPathUseCase } from './content/get-asset-content-by-path';
export { GetKeyBindingsUseCase } from './settings/get-key-bindings';
export { UpdateKeyBindingUseCase } from './settings/update-key-binding';
export { ResetKeyBindingUseCase } from './settings/reset-key-binding';
export { GetEditorPreferencesUseCase } from './settings/get-editor-preferences';
export { SaveEditorPreferencesUseCase } from './settings/save-editor-preferences';
export { GetProjectRenderConfigUseCase } from './settings/get-project-render-config';
export { SaveProjectRenderConfigUseCase } from './settings/save-project-render-config';
export {
  requireRenderConfigEditor,
  requireRenderConfigMember,
  RENDER_CONFIG_RESOURCE_TYPE,
  type RenderConfigAuthzContext,
} from './settings/render-config-authorization';
export { UpdateProfileUseCase } from './auth/update-profile';
export type { UpdateProfileInput, UpdateProfileResult } from './auth/update-profile';
export { ListAuditLogsUseCase } from './admin/list-audit-logs';
export { ListFailedSignInAttemptsUseCase } from './admin/list-failed-sign-ins';
export { PurgeAuthAttemptTelemetryUseCase } from './admin/purge-auth-attempt-telemetry';
export type { PurgeAuthAttemptTelemetryInput, PurgeAuthAttemptTelemetryResult } from './admin/purge-auth-attempt-telemetry';
export { RecordFailedSignInUseCase, UNKNOWN_IP } from './auth/record-failed-sign-in';
export type { RecordFailedSignInInputDto } from './auth/record-failed-sign-in';
export { RecordPasswordResetRequestUseCase } from './auth/record-password-reset-request';
export type { RecordPasswordResetRequestInputDto } from './auth/record-password-reset-request';
export { RecordAuditEventUseCase } from './auth/record-audit-event';
export type { RecordAuditEventInput } from './auth/record-audit-event';
export { withOrigin } from './audit-metadata';
export { saveAuditBestEffort, recordAuthorizationDenial, recordAuditSuccess } from './audit-recording';
export type { AuthorizationDenial, AuditSuccessRecord } from './audit-recording';
export { resolveDownloadContentSource, buildResolverDeps } from './project/download-content-source';
export type { DownloadContentSource, ResolveDownloadContentSourceDeps } from './project/download-content-source';
export { DownloadFileUseCase } from './project/download-file';
export type { DownloadFileResult } from './project/download-file';
export { DownloadProjectUseCase } from './project/download-project';
export type { DownloadProjectResult, DownloadProjectFile } from './project/download-project';
export { OpenCollaborationSessionUseCase } from './project/open-collaboration-session';
export { CloseCollaborationSessionUseCase } from './project/close-collaboration-session';

// review/ (feature 038)
export * from './review';
export {
  GetPdfExtensionCatalogueUseCase,
  type PdfExtensionCatalogue,
  type PdfExtensionConflict,
  type GetPdfExtensionCatalogueInput,
} from './project/get-pdf-extension-catalogue';

// grammar/ (feature 042)
export { AddDictionaryTermUseCase } from './grammar/add-dictionary-term';
export { RemoveDictionaryTermUseCase } from './grammar/remove-dictionary-term';
export { ListDictionaryTermsUseCase } from './grammar/list-dictionary-terms';
export {
  requireDictionaryEditor,
  requireDictionaryMember,
  DICTIONARY_RESOURCE_TYPE,
} from './grammar/grammar-authorization';
export { GetIgnoredLintsUseCase } from './grammar/get-ignored-lints';
export { ReplaceIgnoredLintsUseCase } from './grammar/replace-ignored-lints';
export { requireDocumentMember, IGNORED_LINT_RESOURCE_TYPE } from './grammar/ignored-lint-authorization';
