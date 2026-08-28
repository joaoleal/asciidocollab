import { AnchorInvalidError } from '../../../src/errors/review/anchor-invalid';
import { DomainError } from '../../../src/errors/domain-error';

describe('AnchorInvalidError', () => {
  it('uses a generic message when no reason is supplied', () => {
    const error = new AnchorInvalidError();

    expect(error.name).toBe('AnchorInvalidError');
    expect(error.message).toBe('Anchor is invalid');
  });

  it('keeps a caller-supplied reason', () => {
    const error = new AnchorInvalidError('Anchor is missing its passage');

    expect(error.message).toBe('Anchor is missing its passage');
  });

  it('is a domain error that survives instanceof checks', () => {
    expect(new AnchorInvalidError()).toBeInstanceOf(DomainError);
    expect(new AnchorInvalidError()).toBeInstanceOf(AnchorInvalidError);
  });
});
