/** @file Re-exports all DTO types from the shared package. */
export type { CreateProjectDto, CreateProjectResultDto } from './create-project.dto';
export type { CloneProjectDto } from './clone-project.dto';
export type { RenameFileDto, RenameFileResultDto } from './rename-file.dto';
export type { DeleteFileDto } from './delete-file.dto';
export type { InviteUserDto } from './invite-user.dto';
export type { RemoveMemberDto } from './remove-member.dto';
export type { ChangeMemberRoleDto } from './change-member-role.dto';
export type { GetProjectTreeDto, FileTreeNodeDto, GetProjectTreeResultDto } from './get-project-tree.dto';
export type {
  RegisterDto,
  LoginDto,
  ChangePasswordDto,
  ResetPasswordDto,
  RequestPasswordResetDto,
  AuthSuccessResponseDto,
  AuthErrorResponseDto,
  UserProfileDto,
  PasswordPolicyDto,
  SetupStatusDto,
  UpdateDisplayNameDto,
  RequestEmailChangeDto,
} from './auth.dto';
export type {
  ListUserProjectsResultDto,
  UpdateProjectDto,
  ArchiveProjectResultDto,
  RestoreProjectResultDto,
  ProjectDto,
} from './project-management.dto';
export type { UserSearchResultDto } from './user-search.dto';
export type {
  AdminUserDto,
  AdminSettingsDto,
  AdminInviteUserDto,
  AcceptInviteDto,
  UserRemovalPreviewDto,
} from './admin.dto';
export type { FileTreeEventDto } from './file-tree-event.dto';
export type { ContentChangedEventDto, MainFileChangedEventDto, ReviewItemsChangedEventDto, ProjectEventDto } from './project-event.dto';
export type { KeyBindingDto } from './key-binding.dto';
export type { EditorPreferencesDto, SpellcheckLanguageDto } from './editor-preferences.dto';
export type { AuditLogDto, AuditLogPageDto } from './audit-log.dto';
export type { CollabAuthRole, CollabDocumentAuthResponse, CollabPresenceAuthResponse, CollabDocumentInfo } from './collab.dto';
export type {
  SearchMode,
  SearchQueryDto,
  SearchMatchDto,
  FileMatchGroupDto,
  SearchResultDto,
} from './project-search.dto';
export type {
  ReplaceScope,
  FileReplaceSelectionDto,
  ReplaceRequestDto,
  ReplaceResultDto,
} from './project-replace.dto';
export type {
  GitProvider,
  GitSyncStatus,
  GitRepositoryDto,
  BranchDto,
  BranchListDto,
  CommitDto,
  PendingChangeType,
  PendingChangeDto,
  GitStatusDto,
  BehindAheadDto,
  DiffDto,
  BlameLineDto,
  BlameDto,
  FileGitStatus,
  ConflictResolution,
  ConflictSummaryDto,
  ConflictListDto,
  ConflictStagesDto,
  GitOperationKind,
  GitOperationState,
  GitOperationStatusDto,
  GitDriftSummaryDto,
  GitDriftAnomalyDto,
  ActiveGitOperationDto,
  PullPreviewDto,
  PushPreviewDto,
} from './git.dto';
export {
  GIT_PROVIDERS,
  isGitProvider,
  GIT_SYNC_STATUSES,
  isGitSyncStatus,
  PENDING_CHANGE_TYPES,
  isPendingChangeType,
  FILE_GIT_STATUSES,
  isFileGitStatus,
  CONFLICT_RESOLUTIONS,
  isConflictResolution,
  GIT_OPERATION_KINDS,
  isGitOperationKind,
  GIT_OPERATION_STATES,
  isGitOperationState,
} from './git.dto';
export type { GitErrorCode, GitErrorDto } from './git-error.dto';
export { GIT_ERROR_CODES, isGitErrorCode } from './git-error.dto';
