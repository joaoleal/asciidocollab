import { FileNode } from '../../src/entities/file-node';
import { FileNodeId } from '../../src/value-objects/ids/file-node-id';
import { ProjectId } from '../../src/value-objects/ids/project-id';
import { FileNodeType } from '../../src/value-objects/files/file-node-type';
import { FilePath } from '../../src/value-objects/files/file-path';

describe('FileNode entity', () => {
  const projectId = ProjectId.create('550e8400-e29b-41d4-a716-446655440000');
  const rootId = FileNodeId.create('550e8400-e29b-41d4-a716-446655440001');
  const childId = FileNodeId.create('550e8400-e29b-41d4-a716-446655440002');

  test('creates root folder with parentId=null', () => {
    const root = new FileNode(
      rootId,
      projectId,
      null,
      'root',
      FileNodeType.create('folder'),
      FilePath.create('/'),
    );
    expect(root.id).toBe(rootId);
    expect(root.projectId).toBe(projectId);
    expect(root.parentId).toBeNull();
    expect(root.name).toBe('root');
    expect(root.type.value).toBe('folder');
    expect(root.path.value).toBe('/');
    expect(root.createdAt).toBeInstanceOf(Date);
    expect(root.updatedAt).toBeInstanceOf(Date);
  });

  test('creates non-root node with non-null parentId', () => {
    const node = new FileNode(
      childId,
      projectId,
      rootId,
      'docs',
      FileNodeType.create('folder'),
      FilePath.create('/docs'),
    );
    expect(node.parentId).toBe(rootId);
    expect(node.parentId).not.toBeNull();
  });

  test('creates file type node', () => {
    const file = new FileNode(
      childId,
      projectId,
      rootId,
      'readme.adoc',
      FileNodeType.create('file'),
      FilePath.create('/readme.adoc'),
    );
    expect(file.type.value).toBe('file');
  });

  test('creates folder type node', () => {
    const folder = new FileNode(
      childId,
      projectId,
      rootId,
      'images',
      FileNodeType.create('folder'),
      FilePath.create('/images'),
    );
    expect(folder.type.value).toBe('folder');
  });

  test('rejects a node whose name is blank', () => {
    expect(
      () =>
        new FileNode(
          childId,
          projectId,
          rootId,
          '',
          FileNodeType.create('folder'),
          FilePath.create('/docs'),
        ),
    ).toThrow('FileNode name must not be empty');

    expect(
      () =>
        new FileNode(
          childId,
          projectId,
          rootId,
          '   ',
          FileNodeType.create('folder'),
          FilePath.create('/docs'),
        ),
    ).toThrow('FileNode name must not be empty');
  });

  test('rejects a file placed at root level, where only folders may live', () => {
    expect(
      () =>
        new FileNode(
          childId,
          projectId,
          null,
          'readme.adoc',
          FileNodeType.create('file'),
          FilePath.create('/readme.adoc'),
        ),
    ).toThrow('Root-level node must be a folder, not a file');
  });

  test('rejects invalid FileNodeType', () => {
    expect(() => FileNodeType.create('symlink')).toThrow();
  });

  test('rejects FilePath without leading slash', () => {
    expect(() => FilePath.create('docs/file.adoc')).toThrow();
  });

  test('rejects FilePath with traversal', () => {
    expect(() => FilePath.create('/docs/../file.adoc')).toThrow();
  });
});
