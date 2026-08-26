import { gitErrorResponse } from '../../src/lib/git-error-response';

describe('gitErrorResponse', () => {
  test.each([
    ['InsufficientRoleError', 403, 'insufficient_role'],
    ['RepositoryNotConnectedError', 404, 'repository_not_connected'],
    ['GitOperationInProgressError', 409, 'git_operation_in_progress'],
    ['NothingStagedError', 409, 'nothing_staged'],
    ['EmptyCommitMessageError', 422, 'empty_commit_message'],
    ['ValidationError', 400, 'validation_error'],
    ['GitCommandFailedError', 500, 'git_command_failed'],
    ['UnresolvedConflictsError', 409, 'unresolved_conflicts'],
    ['NothingToUndoError', 409, 'nothing_to_undo'],
    ['GitConflictNotFoundError', 422, 'validation_error'],
    ['NoConflictInProgressError', 404, 'no_conflict_in_progress'],
    ['InvalidResolutionError', 422, 'validation_error'],
    ['RepositoryUnreachableError', 422, 'repository_unreachable'],
    ['AuthenticationFailedError', 401, 'authentication_failed'],
    ['RepositoryAlreadyConnectedError', 409, 'already_connected'],
    ['CommitAlreadyPushedError', 409, 'commit_already_pushed'],
  ])('maps %s to %i / %s', (name, status, code) => {
    const result = gitErrorResponse(name);
    expect(result.status).toBe(status);
    expect(result.body.error.code).toBe(code);
    expect(typeof result.body.error.message).toBe('string');
    expect(result.body.error.message.length).toBeGreaterThan(0);
  });

  test('maps an unknown error name to a generic 500', () => {
    const result = gitErrorResponse('SomeNoveltyError');
    expect(result.status).toBe(500);
    expect(result.body.error.code).toBe('internal_error');
  });

  test('maps LiveContentFlushFailedError to 409 and surfaces the offending path', () => {
    const result = gitErrorResponse('LiveContentFlushFailedError', '/docs/intro.adoc');
    expect(result.status).toBe(409);
    expect(result.body.error.code).toBe('live_content_flush_failed');
    expect(result.body.error.message).toContain('/docs/intro.adoc');
    expect(result.body.error.details?.path).toBe('/docs/intro.adoc');
    expect((result.body as unknown as Record<string, unknown>).path).toBeUndefined();
  });

  test('maps LiveContentFlushFailedError to a safe generic message when no path is given', () => {
    const result = gitErrorResponse('LiveContentFlushFailedError');
    expect(result.status).toBe(409);
    expect(result.body.error.code).toBe('live_content_flush_failed');
    expect(result.body.error.details).toBeUndefined();
  });

  test('never echoes a worker secret or token even if smuggled in as the error name', () => {
    const result = gitErrorResponse('x-git-worker-internal-secret: abc123');
    expect(result.status).toBe(500);
    expect(JSON.stringify(result.body)).not.toContain('abc123');
  });
});
