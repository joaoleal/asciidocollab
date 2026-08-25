import { Project } from '../../src/entities/project';
import { ProjectId } from '../../src/value-objects/ids/project-id';
import { ProjectName } from '../../src/value-objects/project/project-name';
import { FileNodeId } from '../../src/value-objects/ids/file-node-id';

describe('Project entity', () => {
  const projectId = ProjectId.create('550e8400-e29b-41d4-a716-446655440000');
  const projectName = ProjectName.create('Test Project');

  test('creates with name', () => {
    const project = new Project(projectId, projectName, null, [], null);
    expect(project.id).toBe(projectId);
    expect(project.name).toBe(projectName);
    expect(project.description).toBeNull();
    expect(project.tags).toEqual([]);
    expect(project.rootFolderId).toBeNull();
    expect(project.archivedAt).toBeNull();
    expect(project.createdAt).toBeInstanceOf(Date);
    expect(project.updatedAt).toBeInstanceOf(Date);
  });

  test('rootFolderId is initially null and can be set', () => {
    const project = new Project(projectId, projectName, null, [], null);
    expect(project.rootFolderId).toBeNull();

    const folderId = FileNodeId.create('550e8400-e29b-41d4-a716-446655440002');
    project.setRootFolderId(folderId);
    expect(project.rootFolderId).toBe(folderId);
  });

  test('removes duplicate tags', () => {
    const project = new Project(
      projectId,
      projectName,
      null,
      ['frontend', 'backend', 'frontend', 'docs', 'backend'],
      null,
    );
    expect(project.tags).toEqual(['frontend', 'backend', 'docs']);
  });

  test('enforces maximum of 10 tags', () => {
    const tags = Array.from({ length: 11 }, (_, index) => `tag-${index}`);
    expect(
      () => new Project(projectId, projectName, null, tags, null),
    ).toThrow();
  });

  test('archivedAt can only be set once', () => {
    const project = new Project(projectId, projectName, null, [], null);
    expect(project.archivedAt).toBeNull();

    project.archive();
    expect(project.archivedAt).toBeInstanceOf(Date);

    expect(() => project.archive()).toThrow();
  });

  test('language defaults to null and can be set or cleared via update', () => {
    const project = new Project(projectId, projectName, null, [], null);
    expect(project.language).toBeNull();

    project.update({ language: 'pt' });
    expect(project.language).toBe('pt');

    project.update({ language: null });
    expect(project.language).toBeNull();
  });

  test('rejects an unsupported language', () => {
    const project = new Project(projectId, projectName, null, [], null);
    expect(() => project.update({ language: 'klingon' as 'en' })).toThrow();
    expect(
      () => new Project(projectId, projectName, null, [], null, undefined, null, null, 'klingon' as 'en'),
    ).toThrow();
  });

  test('gitIgnorePatterns defaults to null and can be set or cleared', () => {
    const project = new Project(projectId, projectName, null, [], null);
    expect(project.gitIgnorePatterns).toBeNull();

    project.setGitIgnorePatterns('build/\n*.log');
    expect(project.gitIgnorePatterns).toBe('build/\n*.log');

    project.setGitIgnorePatterns(null);
    expect(project.gitIgnorePatterns).toBeNull();
  });

  test('normalizes an empty/whitespace-only gitIgnorePatterns value to null', () => {
    const project = new Project(projectId, projectName, null, [], null);

    project.setGitIgnorePatterns('   \n  ');
    expect(project.gitIgnorePatterns).toBeNull();
  });

  test('rejects gitIgnorePatterns beyond the maximum length', () => {
    const project = new Project(projectId, projectName, null, [], null);
    const tooLong = 'a'.repeat(20_001);

    expect(() => project.setGitIgnorePatterns(tooLong)).toThrow();
  });

  test('can be constructed with an initial gitIgnorePatterns value', () => {
    const project = new Project(
      projectId,
      projectName,
      null,
      [],
      null,
      undefined,
      null,
      null,
      null,
      'dist/',
    );
    expect(project.gitIgnorePatterns).toBe('dist/');
  });
});
