import { GIT_ERROR_CODES, isGitErrorCode } from '../../src/dtos/git-error.dto';
import type { GitErrorCode, GitErrorDto } from '../../src/dtos/git-error.dto';

describe('git error codes', () => {
  test('is the exact, exhaustive vocabulary of typed git-sync errors', () => {
    expect(GIT_ERROR_CODES).toEqual([
      'repository_unreachable',
      'authentication_failed',
      'already_connected',
      'non_fast_forward',
      'merge_conflict',
      'git_operation_in_progress',
      'insufficient_role',
      'nothing_staged',
      'empty_commit_message',
      'remote_already_initialized',
      'remote_history_rewritten',
      'unresolved_conflicts',
      'nothing_to_undo',
      'commit_already_pushed',
      'repository_too_large',
    ]);
  });

  test('every code is unique', () => {
    expect(new Set(GIT_ERROR_CODES).size).toBe(GIT_ERROR_CODES.length);
  });

  test('type guard accepts members and rejects non-members', () => {
    expect(isGitErrorCode('merge_conflict')).toBe(true);
    expect(isGitErrorCode('MERGE_CONFLICT')).toBe(false);
    expect(isGitErrorCode('not_a_code')).toBe(false);
  });

  test('already_connected narrows via isGitErrorCode and is part of the vocabulary', () => {
    expect(isGitErrorCode('already_connected')).toBe(true);
    expect(GIT_ERROR_CODES).toContain('already_connected');
  });

  test('GitErrorDto pairs a stable code with a safe, human-readable message', () => {
    const code: GitErrorCode = 'insufficient_role';
    const dto: GitErrorDto = { code, message: 'You do not have permission to perform this action.' };
    expect(dto.code).toBe('insufficient_role');
    expect(dto.message).not.toContain('internals');
  });
});
