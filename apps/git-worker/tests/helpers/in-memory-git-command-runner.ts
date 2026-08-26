import type {
  AuthenticationFailedError,
  ClonedRepository,
  GitAmendError,
  GitAmendInput,
  GitBehindAhead,
  GitBlameLine,
  GitBranchList,
  GitCheckoutInput,
  GitCheckoutOutcome,
  GitCloneInput,
  GitCommandFailedError,
  GitCommandRunner,
  GitCommitResult,
  GitCreateBranchInput,
  GitCreatedBranch,
  GitDiffResult,
  GitDiscardInput,
  GitFetchInput,
  GitFetchResult,
  GitInitializeError,
  GitInitializeInput,
  GitInitializeOutcome,
  GitLogEntry,
  GitMergeFileChange,
  GitMergeInput,
  GitMergeOutcome,
  GitPreviewPullResult,
  GitPreviewPushResult,
  GitPushError,
  GitPushInput,
  GitPushResult,
  GitRemoteAccessCheck,
  GitResolveMergeInput,
  GitResolveMergeOutcome,
  GitRestoreOutcome,
  GitRestoreToSnapshotInput,
  GitWorkingTreeStatus,
  ProjectId,
  RepositoryTooLargeError,
  RepositoryUnreachableError,
  Result,
} from '@asciidocollab/domain';

/** Every typed way {@link InMemoryGitCommandRunner.fetch} can be seeded to fail. */
type FetchError = RepositoryUnreachableError | AuthenticationFailedError | GitCommandFailedError;

/**
 * A local, minimal in-memory `GitCommandRunner` fake for this app's tests, covering what
 * `ImportRepositoryUseCase` (`clone`), `PushChangesUseCase` (`push`), and `ConnectRepositoryUseCase`
 * (`checkRemoteAccess`) exercise. See `in-memory-git-operation-repository.ts`'s class docs for why
 * this app keeps its own fakes rather than reusing `packages/domain/tests`'.
 */
export class InMemoryGitCommandRunner implements GitCommandRunner {
  private readonly remoteAccessFailures = new Map<
    string,
    RepositoryUnreachableError | AuthenticationFailedError
  >();
  private readonly clonedRepositories = new Map<string, ClonedRepository>();
  private readonly cloneFailures = new Map<
    string,
    RepositoryUnreachableError | AuthenticationFailedError | GitCommandFailedError | RepositoryTooLargeError
  >();
  private readonly pushResults = new Map<string, GitPushResult>();
  private readonly pushFailures = new Map<string, GitPushError>();
  private readonly initializeResults = new Map<string, GitInitializeOutcome>();
  private readonly initializeFailures = new Map<string, GitInitializeError>();
  private readonly fetchResults = new Map<string, GitFetchResult>();
  private readonly fetchFailures = new Map<string, FetchError>();
  private readonly behindAheadResults = new Map<string, GitBehindAhead>();
  private readonly behindAheadFailures = new Map<string, GitCommandFailedError>();
  private readonly mergeResults = new Map<string, GitMergeOutcome>();
  private readonly mergeFailures = new Map<string, GitCommandFailedError>();
  private readonly checkoutResults = new Map<string, GitCheckoutOutcome>();
  private readonly checkoutFailures = new Map<string, GitCommandFailedError>();
  private readonly createBranchResults = new Map<string, GitCreatedBranch>();
  private readonly createBranchFailures = new Map<string, GitCommandFailedError>();
  private readonly listBranchesResults = new Map<string, GitBranchList>();
  private readonly listBranchesFailures = new Map<string, GitCommandFailedError>();
  private readonly resolveMergeResults = new Map<string, GitResolveMergeOutcome>();
  private readonly resolveMergeFailures = new Map<string, GitCommandFailedError>();
  private readonly restoreToSnapshotResults = new Map<string, GitRestoreOutcome>();
  private readonly restoreToSnapshotFailures = new Map<string, GitCommandFailedError>();
  private readonly discardChangesResults = new Map<string, GitMergeFileChange[]>();
  private readonly discardChangesFailures = new Map<string, GitCommandFailedError>();
  private readonly amendCommitResults = new Map<string, GitCommitResult>();
  private readonly amendCommitFailures = new Map<string, GitAmendError>();

  /** Every call made to `checkRemoteAccess`, in call order, for asserting interactions. */
  readonly remoteAccessCalls: GitRemoteAccessCheck[] = [];

  /** Every call made to `clone`, in call order, for asserting interactions. */
  readonly cloneCalls: GitCloneInput[] = [];

  /** Every call made to `push`, in call order, for asserting interactions. */
  readonly pushCalls: { projectId: ProjectId; input: GitPushInput }[] = [];

  /** Every call made to `initializeAndPublish`, in call order, for asserting interactions. */
  readonly initializeAndPublishCalls: { projectId: ProjectId; input: GitInitializeInput }[] = [];

  /** Every call made to `fetch`, in call order, for asserting interactions. */
  readonly fetchCalls: { projectId: ProjectId; input: GitFetchInput }[] = [];

  /** Every call made to `getBehindAhead`, in call order, for asserting interactions. */
  readonly getBehindAheadCalls: { projectId: ProjectId; branch: string }[] = [];

  /** Every call made to `merge`, in call order, for asserting interactions. */
  readonly mergeCalls: { projectId: ProjectId; input: GitMergeInput }[] = [];

  /** Every call made to `checkout`, in call order, for asserting interactions. */
  readonly checkoutCalls: { projectId: ProjectId; input: GitCheckoutInput }[] = [];

  /** Every call made to `createBranch`, in call order, for asserting interactions. */
  readonly createBranchCalls: { projectId: ProjectId; input: GitCreateBranchInput }[] = [];

  /** Every call made to `listBranches`, in call order, for asserting interactions. */
  readonly listBranchesCalls: ProjectId[] = [];

  /** Every call made to `resolveMerge`, in call order, for asserting interactions. */
  readonly resolveMergeCalls: { projectId: ProjectId; input: GitResolveMergeInput }[] = [];

  /** Every call made to `restoreToSnapshot`, in call order, for asserting interactions. */
  readonly restoreToSnapshotCalls: { projectId: ProjectId; input: GitRestoreToSnapshotInput }[] = [];

  /** Every call made to `discardChanges`, in call order, for asserting interactions. */
  readonly discardChangesCalls: { projectId: ProjectId; input: GitDiscardInput }[] = [];

  /** Every call made to `amendCommit`, in call order, for asserting interactions. */
  readonly amendCommitCalls: { projectId: ProjectId; input: GitAmendInput }[] = [];

  /** Configures `checkRemoteAccess` to fail for a remote URL, taking priority over its default success. */
  seedRemoteAccessFailure(remoteUrl: string, error: RepositoryUnreachableError | AuthenticationFailedError): void {
    this.remoteAccessFailures.set(remoteUrl, error);
  }

  /** Configures `clone` to return `repository` for a remote URL. */
  seedClone(remoteUrl: string, repository: ClonedRepository): void {
    this.clonedRepositories.set(remoteUrl, repository);
  }

  /** Configures `clone` to fail for a remote URL, taking priority over any seeded repository. */
  seedCloneFailure(
    remoteUrl: string,
    error: RepositoryUnreachableError | AuthenticationFailedError | GitCommandFailedError | RepositoryTooLargeError,
  ): void {
    this.cloneFailures.set(remoteUrl, error);
  }

  /** Configures `push` to return `result` for a project. */
  seedPush(projectId: ProjectId, result: GitPushResult): void {
    this.pushResults.set(projectId.value, result);
  }

  /** Configures `push` to fail for a project, taking priority over any seeded result. */
  seedPushFailure(projectId: ProjectId, error: GitPushError): void {
    this.pushFailures.set(projectId.value, error);
  }

  /** Configures `initializeAndPublish` to return `outcome` for a project. */
  seedInitializeAndPublish(projectId: ProjectId, outcome: GitInitializeOutcome): void {
    this.initializeResults.set(projectId.value, outcome);
  }

  /** Configures `initializeAndPublish` to fail for a project, taking priority over any seeded outcome. */
  seedInitializeAndPublishFailure(projectId: ProjectId, error: GitInitializeError): void {
    this.initializeFailures.set(projectId.value, error);
  }

  /** Configures `fetch` to return `result` for a project. */
  seedFetch(projectId: ProjectId, result: GitFetchResult): void {
    this.fetchResults.set(projectId.value, result);
  }

  /** Configures `fetch` to fail for a project, taking priority over any seeded result. */
  seedFetchFailure(projectId: ProjectId, error: FetchError): void {
    this.fetchFailures.set(projectId.value, error);
  }

  /** Configures `getBehindAhead` to return `result` for a project. */
  seedBehindAhead(projectId: ProjectId, result: GitBehindAhead): void {
    this.behindAheadResults.set(projectId.value, result);
  }

  /** Configures `getBehindAhead` to fail for a project, taking priority over any seeded result. */
  seedBehindAheadFailure(projectId: ProjectId, error: GitCommandFailedError): void {
    this.behindAheadFailures.set(projectId.value, error);
  }

  /** Configures `merge` to return `outcome` (merged or conflicted) for a project. */
  seedMerge(projectId: ProjectId, outcome: GitMergeOutcome): void {
    this.mergeResults.set(projectId.value, outcome);
  }

  /** Configures `merge` to fail for a project, taking priority over any seeded outcome. */
  seedMergeFailure(projectId: ProjectId, error: GitCommandFailedError): void {
    this.mergeFailures.set(projectId.value, error);
  }

  /** Configures `checkout` to return `outcome` (switched or conflicted) for a project. */
  seedCheckout(projectId: ProjectId, outcome: GitCheckoutOutcome): void {
    this.checkoutResults.set(projectId.value, outcome);
  }

  /** Configures `checkout` to fail for a project, taking priority over any seeded outcome. */
  seedCheckoutFailure(projectId: ProjectId, error: GitCommandFailedError): void {
    this.checkoutFailures.set(projectId.value, error);
  }

  /** Configures `createBranch` to return `result` for a project. */
  seedCreateBranch(projectId: ProjectId, result: GitCreatedBranch): void {
    this.createBranchResults.set(projectId.value, result);
  }

  /** Configures `createBranch` to fail for a project, taking priority over any seeded result. */
  seedCreateBranchFailure(projectId: ProjectId, error: GitCommandFailedError): void {
    this.createBranchFailures.set(projectId.value, error);
  }

  /** Configures `listBranches` to return `result` for a project. */
  seedListBranches(projectId: ProjectId, result: GitBranchList): void {
    this.listBranchesResults.set(projectId.value, result);
  }

  /** Configures `listBranches` to fail for a project, taking priority over any seeded result. */
  seedListBranchesFailure(projectId: ProjectId, error: GitCommandFailedError): void {
    this.listBranchesFailures.set(projectId.value, error);
  }

  /** Configures `resolveMerge` to return `outcome` (resolved or stillConflicted) for a project. */
  seedResolveMerge(projectId: ProjectId, outcome: GitResolveMergeOutcome): void {
    this.resolveMergeResults.set(projectId.value, outcome);
  }

  /** Configures `resolveMerge` to fail for a project, taking priority over any seeded outcome. */
  seedResolveMergeFailure(projectId: ProjectId, error: GitCommandFailedError): void {
    this.resolveMergeFailures.set(projectId.value, error);
  }

  /** Configures `restoreToSnapshot` to return `outcome` for a project. */
  seedRestoreToSnapshot(projectId: ProjectId, outcome: GitRestoreOutcome): void {
    this.restoreToSnapshotResults.set(projectId.value, outcome);
  }

  /** Configures `restoreToSnapshot` to fail for a project, taking priority over any seeded outcome. */
  seedRestoreToSnapshotFailure(projectId: ProjectId, error: GitCommandFailedError): void {
    this.restoreToSnapshotFailures.set(projectId.value, error);
  }

  /** Configures `discardChanges` to return `changes` for a project. */
  seedDiscardChanges(projectId: ProjectId, changes: GitMergeFileChange[]): void {
    this.discardChangesResults.set(projectId.value, changes);
  }

  /** Configures `discardChanges` to fail for a project, taking priority over any seeded result. */
  seedDiscardChangesFailure(projectId: ProjectId, error: GitCommandFailedError): void {
    this.discardChangesFailures.set(projectId.value, error);
  }

  /** Configures `amendCommit` to return `result` for a project. */
  seedAmendCommit(projectId: ProjectId, result: GitCommitResult): void {
    this.amendCommitResults.set(projectId.value, result);
  }

  /** Configures `amendCommit` to fail for a project, taking priority over any seeded result. */
  seedAmendCommitFailure(projectId: ProjectId, error: GitAmendError): void {
    this.amendCommitFailures.set(projectId.value, error);
  }

  async getStatus(): Promise<Result<GitWorkingTreeStatus, GitCommandFailedError>> {
    throw new Error('not used by these tests');
  }

  /**
   * Records the call and reports success, unless a failure was seeded for this remote URL via
   * `seedRemoteAccessFailure`.
   */
  async checkRemoteAccess(
    check: GitRemoteAccessCheck,
  ): Promise<Result<void, RepositoryUnreachableError | AuthenticationFailedError>> {
    this.remoteAccessCalls.push(check);

    const failure = this.remoteAccessFailures.get(check.remoteUrl);
    if (failure) return { success: false, error: failure };

    return { success: true, value: undefined };
  }

  async clone(
    input: GitCloneInput,
  ): Promise<
    Result<
      ClonedRepository,
      RepositoryUnreachableError | AuthenticationFailedError | GitCommandFailedError | RepositoryTooLargeError
    >
  > {
    this.cloneCalls.push(input);

    const failure = this.cloneFailures.get(input.remoteUrl);
    if (failure) return { success: false, error: failure };

    const repository = this.clonedRepositories.get(input.remoteUrl);
    if (!repository) {
      throw new Error(`no clone result seeded for ${input.remoteUrl}`);
    }

    return { success: true, value: repository };
  }

  async stage(): Promise<Result<void, GitCommandFailedError>> {
    throw new Error('not used by these tests');
  }

  async unstage(): Promise<Result<void, GitCommandFailedError>> {
    throw new Error('not used by these tests');
  }

  async commit(): Promise<Result<GitCommitResult, GitCommandFailedError>> {
    throw new Error('not used by these tests');
  }

  async push(projectId: ProjectId, input: GitPushInput): Promise<Result<GitPushResult, GitPushError>> {
    this.pushCalls.push({ projectId, input });

    const failure = this.pushFailures.get(projectId.value);
    if (failure) return { success: false, error: failure };

    const result = this.pushResults.get(projectId.value);
    if (!result) {
      throw new Error(`no push result seeded for ${projectId.value}`);
    }

    return { success: true, value: result };
  }

  async initializeAndPublish(
    projectId: ProjectId,
    input: GitInitializeInput,
  ): Promise<Result<GitInitializeOutcome, GitInitializeError>> {
    this.initializeAndPublishCalls.push({ projectId, input });

    const failure = this.initializeFailures.get(projectId.value);
    if (failure) return { success: false, error: failure };

    const outcome = this.initializeResults.get(projectId.value);
    if (!outcome) {
      throw new Error(`no initializeAndPublish outcome seeded for ${projectId.value}`);
    }

    return { success: true, value: outcome };
  }

  async fetch(
    projectId: ProjectId,
    input: GitFetchInput,
  ): Promise<Result<GitFetchResult, FetchError>> {
    this.fetchCalls.push({ projectId, input });

    const failure = this.fetchFailures.get(projectId.value);
    if (failure) return { success: false, error: failure };

    const result = this.fetchResults.get(projectId.value);
    if (!result) {
      throw new Error(`no fetch result seeded for ${projectId.value}`);
    }

    return { success: true, value: result };
  }

  async getBehindAhead(projectId: ProjectId, branch: string): Promise<Result<GitBehindAhead, GitCommandFailedError>> {
    this.getBehindAheadCalls.push({ projectId, branch });

    const failure = this.behindAheadFailures.get(projectId.value);
    if (failure) return { success: false, error: failure };

    const result = this.behindAheadResults.get(projectId.value);
    if (!result) {
      throw new Error(`no behind/ahead result seeded for ${projectId.value}`);
    }

    return { success: true, value: result };
  }

  async merge(projectId: ProjectId, input: GitMergeInput): Promise<Result<GitMergeOutcome, GitCommandFailedError>> {
    this.mergeCalls.push({ projectId, input });

    const failure = this.mergeFailures.get(projectId.value);
    if (failure) return { success: false, error: failure };

    const outcome = this.mergeResults.get(projectId.value);
    if (!outcome) {
      throw new Error(`no merge outcome seeded for ${projectId.value}`);
    }

    return { success: true, value: outcome };
  }

  async checkout(
    projectId: ProjectId,
    input: GitCheckoutInput,
  ): Promise<Result<GitCheckoutOutcome, GitCommandFailedError>> {
    this.checkoutCalls.push({ projectId, input });

    const failure = this.checkoutFailures.get(projectId.value);
    if (failure) return { success: false, error: failure };

    const outcome = this.checkoutResults.get(projectId.value);
    if (!outcome) {
      throw new Error(`no checkout outcome seeded for ${projectId.value}`);
    }

    return { success: true, value: outcome };
  }

  async createBranch(
    projectId: ProjectId,
    input: GitCreateBranchInput,
  ): Promise<Result<GitCreatedBranch, GitCommandFailedError>> {
    this.createBranchCalls.push({ projectId, input });

    const failure = this.createBranchFailures.get(projectId.value);
    if (failure) return { success: false, error: failure };

    const result = this.createBranchResults.get(projectId.value);
    if (!result) {
      throw new Error(`no createBranch result seeded for ${projectId.value}`);
    }

    return { success: true, value: result };
  }

  async listBranches(projectId: ProjectId): Promise<Result<GitBranchList, GitCommandFailedError>> {
    this.listBranchesCalls.push(projectId);

    const failure = this.listBranchesFailures.get(projectId.value);
    if (failure) return { success: false, error: failure };

    const result = this.listBranchesResults.get(projectId.value);
    if (!result) {
      throw new Error(`no listBranches result seeded for ${projectId.value}`);
    }

    return { success: true, value: result };
  }

  async resolveMerge(
    projectId: ProjectId,
    input: GitResolveMergeInput,
  ): Promise<Result<GitResolveMergeOutcome, GitCommandFailedError>> {
    this.resolveMergeCalls.push({ projectId, input });

    const failure = this.resolveMergeFailures.get(projectId.value);
    if (failure) return { success: false, error: failure };

    const outcome = this.resolveMergeResults.get(projectId.value);
    if (!outcome) {
      throw new Error(`no resolveMerge outcome seeded for ${projectId.value}`);
    }

    return { success: true, value: outcome };
  }

  async restoreToSnapshot(
    projectId: ProjectId,
    input: GitRestoreToSnapshotInput,
  ): Promise<Result<GitRestoreOutcome, GitCommandFailedError>> {
    this.restoreToSnapshotCalls.push({ projectId, input });

    const failure = this.restoreToSnapshotFailures.get(projectId.value);
    if (failure) return { success: false, error: failure };

    const outcome = this.restoreToSnapshotResults.get(projectId.value);
    if (!outcome) {
      throw new Error(`no restoreToSnapshot outcome seeded for ${projectId.value}`);
    }

    return { success: true, value: outcome };
  }

  async log(): Promise<Result<GitLogEntry[], GitCommandFailedError>> {
    throw new Error('not used by these tests');
  }

  async diff(): Promise<Result<GitDiffResult, GitCommandFailedError>> {
    throw new Error('not used by these tests');
  }

  async blame(): Promise<Result<GitBlameLine[], GitCommandFailedError>> {
    throw new Error('not used by these tests');
  }

  async discardChanges(
    projectId: ProjectId,
    input: GitDiscardInput,
  ): Promise<Result<GitMergeFileChange[], GitCommandFailedError>> {
    this.discardChangesCalls.push({ projectId, input });

    const failure = this.discardChangesFailures.get(projectId.value);
    if (failure) return { success: false, error: failure };

    const changes = this.discardChangesResults.get(projectId.value);
    if (!changes) {
      throw new Error(`no discardChanges result seeded for ${projectId.value}`);
    }

    return { success: true, value: changes };
  }

  async previewPull(): Promise<
    Result<GitPreviewPullResult, RepositoryUnreachableError | AuthenticationFailedError | GitCommandFailedError>
  > {
    throw new Error('not used by these tests');
  }

  async previewPush(): Promise<Result<GitPreviewPushResult, GitCommandFailedError>> {
    throw new Error('not used by these tests');
  }

  async amendCommit(projectId: ProjectId, input: GitAmendInput): Promise<Result<GitCommitResult, GitAmendError>> {
    this.amendCommitCalls.push({ projectId, input });

    const failure = this.amendCommitFailures.get(projectId.value);
    if (failure) return { success: false, error: failure };

    const result = this.amendCommitResults.get(projectId.value);
    if (!result) {
      throw new Error(`no amendCommit result seeded for ${projectId.value}`);
    }

    return { success: true, value: result };
  }
}
