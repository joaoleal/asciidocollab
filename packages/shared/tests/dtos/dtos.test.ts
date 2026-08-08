import { CreateProjectDto, CreateProjectResultDto } from '../../src/dtos/create-project.dto';
import { RenameFileDto, RenameFileResultDto } from '../../src/dtos/rename-file.dto';
import { DeleteFileDto } from '../../src/dtos/delete-file.dto';
import { InviteUserDto } from '../../src/dtos/invite-user.dto';
import { RemoveMemberDto } from '../../src/dtos/remove-member.dto';
import { ChangeMemberRoleDto } from '../../src/dtos/change-member-role.dto';
import { GetProjectTreeDto, FileTreeNodeDto, GetProjectTreeResultDto } from '../../src/dtos/get-project-tree.dto';
import {
  ContentChangedEventDto,
  MainFileChangedEventDto,
  ProjectEventDto,
} from '../../src/dtos/project-event.dto';
import { FileTreeEventDto } from '../../src/dtos/file-tree-event.dto';

describe('CreateProject DTOs', () => {
  test('CreateProjectDto shape', () => {
    const dto: CreateProjectDto = {
      actorId: '550e8400-e29b-41d4-a716-446655440000',
      name: 'My Project',
      description: 'A test project',
      initialTags: ['docs', 'frontend'],
    };
    expect(dto.actorId).toBeDefined();
    expect(dto.name).toBe('My Project');
    expect(dto.initialTags).toHaveLength(2);
  });

  test('CreateProjectResultDto shape', () => {
    const dto: CreateProjectResultDto = {
      projectId: '550e8400-e29b-41d4-a716-446655440001',
      rootFolderId: '550e8400-e29b-41d4-a716-446655440002',
      ownerRole: 'owner',
    };
    expect(dto.ownerRole).toBe('owner');
  });
});

describe('RenameFile DTOs', () => {
  test('RenameFileDto shape', () => {
    const dto: RenameFileDto = {
      actorId: '550e8400-e29b-41d4-a716-446655440000',
      fileNodeId: '550e8400-e29b-41d4-a716-446655440001',
      newName: 'new-name.txt',
      projectId: '550e8400-e29b-41d4-a716-446655440002',
    };
    expect(dto.newName).toBe('new-name.txt');
  });

  test('RenameFileResultDto shape', () => {
    const dto: RenameFileResultDto = {
      fileNodeId: '550e8400-e29b-41d4-a716-446655440001',
      newName: 'new-name.txt',
      newPath: '/new-name.txt',
    };
    expect(dto.newPath).toBe('/new-name.txt');
  });
});

describe('DeleteFile DTO', () => {
  test('DeleteFileDto shape', () => {
    const dto: DeleteFileDto = {
      actorId: '550e8400-e29b-41d4-a716-446655440000',
      fileNodeId: '550e8400-e29b-41d4-a716-446655440001',
      projectId: '550e8400-e29b-41d4-a716-446655440002',
    };
    expect(dto.fileNodeId).toBeDefined();
  });
});

describe('InviteUser DTO', () => {
  test('InviteUserDto shape', () => {
    const dto: InviteUserDto = {
      actorId: '550e8400-e29b-41d4-a716-446655440000',
      projectId: '550e8400-e29b-41d4-a716-446655440001',
      email: 'user@example.com',
      role: 'editor',
    };
    expect(dto.email).toBe('user@example.com');
    expect(dto.role).toBe('editor');
  });
});

describe('RemoveMember DTO', () => {
  test('RemoveMemberDto shape', () => {
    const dto: RemoveMemberDto = {
      actorId: '550e8400-e29b-41d4-a716-446655440000',
      projectId: '550e8400-e29b-41d4-a716-446655440001',
      targetUserId: '550e8400-e29b-41d4-a716-446655440002',
    };
    expect(dto.targetUserId).toBeDefined();
  });
});

describe('ChangeMemberRole DTO', () => {
  test('ChangeMemberRoleDto shape', () => {
    const dto: ChangeMemberRoleDto = {
      actorId: '550e8400-e29b-41d4-a716-446655440000',
      projectId: '550e8400-e29b-41d4-a716-446655440001',
      targetUserId: '550e8400-e29b-41d4-a716-446655440002',
      newRole: 'administrator',
    };
    expect(dto.newRole).toBe('administrator');
  });
});

describe('GetProjectTree DTOs', () => {
  test('GetProjectTreeDto shape', () => {
    const dto: GetProjectTreeDto = {
      actorId: '550e8400-e29b-41d4-a716-446655440000',
      projectId: '550e8400-e29b-41d4-a716-446655440001',
    };
    expect(dto.projectId).toBeDefined();
  });

  test('FileTreeNodeDto nested shape', () => {
    const child: FileTreeNodeDto = {
      id: '550e8400-e29b-41d4-a716-446655440003',
      name: 'readme.md',
      type: 'file',
      path: '/readme.md',
      mimeType: 'text/markdown',
      children: [],
    };

    const root: FileTreeNodeDto = {
      id: '550e8400-e29b-41d4-a716-446655440001',
      name: 'root',
      type: 'folder',
      path: '/',
      children: [child],
    };

    expect(root.children).toHaveLength(1);
    expect(root.children[0].mimeType).toBe('text/markdown');

    const result: GetProjectTreeResultDto = { root };
    expect(result.root.id).toBe(root.id);
  });
});

describe('ProjectEvent DTOs', () => {
  test('ContentChangedEventDto shape', () => {
    const dto: ContentChangedEventDto = {
      type: 'content-changed',
      fileNodeId: '550e8400-e29b-41d4-a716-446655440001',
    };
    expect(dto.type).toBe('content-changed');
    expect(dto.fileNodeId).toBeDefined();
  });

  test('MainFileChangedEventDto carries a main file id or null', () => {
    const set: MainFileChangedEventDto = {
      type: 'main-file-changed',
      mainFileNodeId: '550e8400-e29b-41d4-a716-446655440002',
    };
    const cleared: MainFileChangedEventDto = { type: 'main-file-changed', mainFileNodeId: null };
    expect(set.mainFileNodeId).toBe('550e8400-e29b-41d4-a716-446655440002');
    expect(cleared.mainFileNodeId).toBeNull();
  });

  test('ProjectEventDto unifies file-tree, content-changed, main-file-changed and review-items-changed and discriminates on type', () => {
    const fileTree: FileTreeEventDto = {
      type: 'created',
      fileNodeId: '550e8400-e29b-41d4-a716-446655440003',
      nodeType: 'file',
      name: 'child.adoc',
      path: '/child.adoc',
      parentId: null,
    };
    const events: ProjectEventDto[] = [
      fileTree,
      { type: 'content-changed', fileNodeId: '550e8400-e29b-41d4-a716-446655440004' },
      { type: 'main-file-changed', mainFileNodeId: null },
      { type: 'review-items-changed', documentId: null },
    ];

    const types = events.map((event) => event.type);
    expect(types).toEqual([
      'created',
      'content-changed',
      'main-file-changed',
      'review-items-changed',
    ]);

    for (const event of events) {
      switch (event.type) {
        case 'content-changed': {
          expect(event.fileNodeId).toBeDefined();
          break;
        }
        case 'main-file-changed': {
          expect('mainFileNodeId' in event).toBe(true);
          break;
        }
        case 'review-items-changed': {
          expect('documentId' in event).toBe(true);
          break;
        }
        default: {
          expect(event.nodeType).toBeDefined();
        }
      }
    }
  });
});
