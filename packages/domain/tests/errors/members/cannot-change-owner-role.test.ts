import { CannotChangeOwnerRoleError } from '../../../src/errors/members/cannot-change-owner-role';
import { DomainError } from '../../../src/errors/domain-error';

describe('CannotChangeOwnerRoleError', () => {
  it('names the project whose owner role was targeted', () => {
    const error = new CannotChangeOwnerRoleError('project-abc');

    expect(error.name).toBe('CannotChangeOwnerRoleError');
    expect(error.message).toBe("Cannot change the owner's role in project project-abc");
  });

  it('is a domain error that survives instanceof checks', () => {
    const error = new CannotChangeOwnerRoleError('project-abc');

    expect(error).toBeInstanceOf(CannotChangeOwnerRoleError);
    expect(error).toBeInstanceOf(DomainError);
    expect(error).toBeInstanceOf(Error);
  });
});
