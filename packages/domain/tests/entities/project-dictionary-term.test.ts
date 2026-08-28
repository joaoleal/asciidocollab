import { ProjectDictionaryTerm } from '../../src/entities/project-dictionary-term';
import { ProjectDictionaryTermId } from '../../src/value-objects/ids/project-dictionary-term-id';
import { ProjectId } from '../../src/value-objects/ids/project-id';
import { UserId } from '../../src/value-objects/ids/user-id';
import { ValidationError } from '../../src/errors/common/validation-error';

const TERM_ID = ProjectDictionaryTermId.create('11111111-1111-4111-8111-111111111111');
const PROJECT = ProjectId.create('22222222-2222-4222-8222-222222222222');
const USER = UserId.create('33333333-3333-4333-8333-333333333333');

describe('ProjectDictionaryTerm', () => {
  it('keeps the accepted term and its attribution', () => {
    const createdAt = new Date('2026-03-04T08:00:00.000Z');
    const entry = new ProjectDictionaryTerm(TERM_ID, PROJECT, 'Asciidoctor', USER, createdAt);

    expect(entry.id).toBe(TERM_ID);
    expect(entry.projectId).toBe(PROJECT);
    expect(entry.term).toBe('Asciidoctor');
    expect(entry.createdByUserId).toBe(USER);
    expect(entry.createdAt).toBe(createdAt);
  });

  it('defaults the creation date to now', () => {
    const before = Date.now();
    const entry = new ProjectDictionaryTerm(TERM_ID, PROJECT, 'Asciidoctor', USER);

    expect(entry.createdAt.getTime()).toBeGreaterThanOrEqual(before);
  });

  it('refuses a blank term so an empty entry can never be persisted', () => {
    expect(() => new ProjectDictionaryTerm(TERM_ID, PROJECT, '', USER)).toThrow(ValidationError);
    expect(() => new ProjectDictionaryTerm(TERM_ID, PROJECT, '   \t ', USER)).toThrow(
      'A dictionary term must not be empty.',
    );
  });
});
