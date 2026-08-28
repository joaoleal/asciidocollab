import { NonFastForwardError } from '../../../src/errors/git/non-fast-forward';
import { DomainError } from '../../../src/errors/domain-error';

describe('NonFastForwardError', () => {
  it('names the rejected branch when it is known', () => {
    const error = new NonFastForwardError('main');

    expect(error.name).toBe('NonFastForwardError');
    expect(error.branch).toBe('main');
    expect(error.message).toContain("'main'");
    expect(error.message).toContain('pull before pushing again');
  });

  it('falls back to a branch-less message when the branch is unknown', () => {
    const error = new NonFastForwardError();

    expect(error.branch).toBeUndefined();
    expect(error.message).toBe(
      'The remote branch has commits this branch does not — pull before pushing again',
    );
  });

  it('is a domain error that survives instanceof checks', () => {
    expect(new NonFastForwardError('main')).toBeInstanceOf(DomainError);
    expect(new NonFastForwardError()).toBeInstanceOf(NonFastForwardError);
  });
});
