import { AssetId } from '../../src/value-objects/ids/asset-id';
import { ProjectId } from '../../src/value-objects/ids/project-id';
import { ValidationError } from '../../src/errors/common/validation-error';

describe('AssetId', () => {
  const VALID = '550e8400-e29b-41d4-a716-446655440000';

  it('wraps a valid UUID v4 string', () => {
    const id = AssetId.create(VALID);

    expect(id).toBeInstanceOf(AssetId);
    expect(id.value).toBe(VALID);
  });

  it('rejects a value that is not a UUID v4', () => {
    expect(() => AssetId.create('not-a-uuid')).toThrow(ValidationError);
    expect(() => AssetId.create('')).toThrow(ValidationError);
    // A UUID whose version nibble is not 4.
    expect(() => AssetId.create('550e8400-e29b-11d4-a716-446655440000')).toThrow(ValidationError);
  });

  it('names itself in the rejection message', () => {
    expect(() => AssetId.create('nope')).toThrow(/AssetId/);
  });

  it('is equal only to another AssetId holding the same value', () => {
    const id = AssetId.create(VALID);

    expect(id.equals(AssetId.create(VALID))).toBe(true);
    expect(id.equals(AssetId.create('550e8400-e29b-41d4-a716-446655440001'))).toBe(false);
    expect(id.equals(ProjectId.create(VALID))).toBe(false);
  });
});
