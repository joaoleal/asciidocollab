import { CannotRemoveOwnerError } from '../../../src/errors/members/cannot-remove-owner';
import { DomainError } from '../../../src/errors/domain-error';

describe('CannotRemoveOwnerError', () => {
  it('names the project the owner cannot be removed from', () => {
    const error = new CannotRemoveOwnerError('project-abc');

    expect(error.name).toBe('CannotRemoveOwnerError');
    expect(error.message).toBe('Cannot remove the owner from project project-abc');
  });

  it('is a domain error that survives instanceof checks', () => {
    const error = new CannotRemoveOwnerError('project-abc');

    expect(error).toBeInstanceOf(CannotRemoveOwnerError);
    expect(error).toBeInstanceOf(DomainError);
    expect(error).toBeInstanceOf(Error);
  });
});
