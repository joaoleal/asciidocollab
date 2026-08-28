import { RepositoryTooLargeError } from '../../../src/errors/git/repository-too-large';
import { DomainError } from '../../../src/errors/domain-error';

describe('RepositoryTooLargeError', () => {
  it('refuses with a fixed message that leaks no size or path detail', () => {
    const error = new RepositoryTooLargeError();

    expect(error.name).toBe('RepositoryTooLargeError');
    expect(error.message).toBe('The repository exceeds the maximum allowed size.');
    expect(error.message).not.toMatch(/\d/);
  });

  it('is a domain error that survives instanceof checks', () => {
    const error = new RepositoryTooLargeError();

    expect(error).toBeInstanceOf(RepositoryTooLargeError);
    expect(error).toBeInstanceOf(DomainError);
    expect(error).toBeInstanceOf(Error);
  });
});
