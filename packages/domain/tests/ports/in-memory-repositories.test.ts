import { InMemoryProjectRepository } from './project/in-memory-project.repository';
import { InMemoryUserRepository } from './user/in-memory-user.repository';
import { InMemoryFileNodeRepository } from './file-tree/in-memory-file-node.repository';
import { InMemoryDocumentRepository } from './file-tree/in-memory-document.repository';
import { InMemoryProjectMemberRepository } from './project/in-memory-project-member.repository';
import { InMemoryGitRepositoryRepository } from './project/in-memory-git-repository.repository';
import { InMemoryTemplateRepository } from './project/in-memory-template.repository';
import { InMemoryAssetRepository } from './file-tree/in-memory-asset.repository';
import { InMemoryAuditLogRepository } from './admin/in-memory-audit-log.repository';
import { InMemoryActiveCloneRegistry } from './project/in-memory-active-clone-registry';
import { Project } from '../../src/entities/project';
import { User } from '../../src/entities/user';
import { FileNode } from '../../src/entities/file-node';
import { Document } from '../../src/entities/document';
import { ProjectMember } from '../../src/entities/project-member';
import { GitRepository } from '../../src/entities/git-repository';
import { Template } from '../../src/entities/template';
import { Asset } from '../../src/entities/asset';
import { AuditLog } from '../../src/entities/audit-log';
import { UserId } from '../../src/value-objects/ids/user-id';
import { ProjectId } from '../../src/value-objects/ids/project-id';
import { FileNodeId } from '../../src/value-objects/ids/file-node-id';
import { DocumentId } from '../../src/value-objects/ids/document-id';
import { GitRepositoryId } from '../../src/value-objects/ids/git-repository-id';
import { TemplateId } from '../../src/value-objects/ids/template-id';
import { AuditLogId } from '../../src/value-objects/ids/audit-log-id';
import { ProjectName } from '../../src/value-objects/project/project-name';
import { Email } from '../../src/value-objects/identity/email';
import { Role } from '../../src/value-objects/identity/role';
import { GitProvider } from '../../src/value-objects/project/git-provider';
import { FileNodeType } from '../../src/value-objects/files/file-node-type';
import { FilePath } from '../../src/value-objects/files/file-path';
import { MimeType } from '../../src/value-objects/files/mime-type';
import { TemplateCategory } from '../../src/value-objects/project/template-category';
import { ContentId } from '../../src/value-objects/ids/content-id';
import { YjsStateId } from '../../src/value-objects/ids/yjs-state-id';

describe('In-Memory Repository Fakes', () => {
  const userId = UserId.create('550e8400-e29b-41d4-a716-446655440001');
  const userId2 = UserId.create('550e8400-e29b-41d4-a716-446655440002');
  const projectId = ProjectId.create('550e8400-e29b-41d4-a716-446655440010');
  const projectId2 = ProjectId.create('550e8400-e29b-41d4-a716-446655440011');
  const fileNodeId = FileNodeId.create('550e8400-e29b-41d4-a716-446655440020');
  const fileNodeId2 = FileNodeId.create('550e8400-e29b-41d4-a716-446655440021');
  const documentId = DocumentId.create('550e8400-e29b-41d4-a716-446655440030');
  const gitRepoId = GitRepositoryId.create('550e8400-e29b-41d4-a716-446655440040');
  const templateId = TemplateId.create('550e8400-e29b-41d4-a716-446655440050');
  const auditLogId = AuditLogId.create('550e8400-e29b-41d4-a716-446655440070');

  describe('InMemoryProjectRepository', () => {
    it('saves and retrieves a project by id', async () => {
      const repo = new InMemoryProjectRepository();
      const project = new Project(projectId, ProjectName.create('Test'), null, [], null);
      await repo.save(project);
      const found = await repo.findById(projectId);
      expect(found).not.toBeNull();
      expect(found!.id.value).toBe(projectId.value);
    });

    it('returns null for unknown id', async () => {
      const repo = new InMemoryProjectRepository();
      const found = await repo.findById(ProjectId.create('550e8400-e29b-41d4-a716-446655440099'));
      expect(found).toBeNull();
    });

    it('finds projects by member id', async () => {
      const repo = new InMemoryProjectRepository();
      const p1 = new Project(projectId, ProjectName.create('P1'), null, [], null);
      const p2 = new Project(projectId2, ProjectName.create('P2'), null, [], null);
      await repo.save(p1);
      await repo.save(p2);
      repo.addMembership(projectId, userId);
      const result = await repo.findByMemberId(userId, { page: 1, limit: 20 });
      expect(result.projects).toHaveLength(1);
      expect(result.projects[0].id.value).toBe(projectId.value);
    });

    it('deletes a project', async () => {
      const repo = new InMemoryProjectRepository();
      const project = new Project(projectId, ProjectName.create('Test'), null, [], null);
      await repo.save(project);
      await repo.delete(projectId);
      const found = await repo.findById(projectId);
      expect(found).toBeNull();
    });
  });

  describe('InMemoryUserRepository', () => {
    it('saves and retrieves by id', async () => {
      const repo = new InMemoryUserRepository();
      const user = new User(userId, Email.create('test@example.com'), 'Test', 'hash', [], null, null);
      await repo.save(user);
      const found = await repo.findById(userId);
      expect(found).not.toBeNull();
      expect(found!.displayName).toBe('Test');
    });

    it('finds by email case-insensitively', async () => {
      const repo = new InMemoryUserRepository();
      const user = new User(userId, Email.create('Test@Example.COM'), 'Test', 'hash', [], null, null);
      await repo.save(user);
      const found = await repo.findByEmail(Email.create('test@example.com'));
      expect(found).not.toBeNull();
    });

    it('returns null for unknown email', async () => {
      const repo = new InMemoryUserRepository();
      const found = await repo.findByEmail(Email.create('unknown@example.com'));
      expect(found).toBeNull();
    });
  });

  describe('InMemoryFileNodeRepository', () => {
    it('saves and retrieves by id', async () => {
      const repo = new InMemoryFileNodeRepository();
      const node = new FileNode(fileNodeId, projectId, null, 'root', FileNodeType.create('folder'), FilePath.create('/'));
      await repo.save(node);
      const found = await repo.findById(fileNodeId);
      expect(found).not.toBeNull();
    });

    it('finds by parent id', async () => {
      const repo = new InMemoryFileNodeRepository();
      const parent = new FileNode(fileNodeId, projectId, null, 'root', FileNodeType.create('folder'), FilePath.create('/'));
      const child = new FileNode(fileNodeId2, projectId, fileNodeId, 'child', FileNodeType.create('folder'), FilePath.create('/child'));
      await repo.save(parent);
      await repo.save(child);
      const children = await repo.findByParentId(fileNodeId);
      expect(children).toHaveLength(1);
      expect(children[0].id.value).toBe(fileNodeId2.value);
    });

    it('finds by project id', async () => {
      const repo = new InMemoryFileNodeRepository();
      const node = new FileNode(fileNodeId, projectId, null, 'root', FileNodeType.create('folder'), FilePath.create('/'));
      await repo.save(node);
      const nodes = await repo.findByProjectId(projectId);
      expect(nodes).toHaveLength(1);
    });

    it('deletes a node', async () => {
      const repo = new InMemoryFileNodeRepository();
      const node = new FileNode(fileNodeId, projectId, null, 'root', FileNodeType.create('folder'), FilePath.create('/'));
      await repo.save(node);
      await repo.delete(fileNodeId);
      const found = await repo.findById(fileNodeId);
      expect(found).toBeNull();
    });

    it('moves a node to a new parent and updates parentId', async () => {
      const repo = new InMemoryFileNodeRepository();
      const parent = new FileNode(fileNodeId, projectId, null, 'root', FileNodeType.create('folder'), FilePath.create('/'));
      const child = new FileNode(fileNodeId2, projectId, fileNodeId, 'child', FileNodeType.create('folder'), FilePath.create('/child'));
      const newParentId = FileNodeId.create('550e8400-e29b-41d4-a716-446655440099');
      const newParent = new FileNode(newParentId, projectId, null, 'new-root', FileNodeType.create('folder'), FilePath.create('/new'));
      await repo.save(parent);
      await repo.save(child);
      await repo.save(newParent);

      await repo.move(child.id, newParentId);
      const moved = await repo.findById(fileNodeId2);
      expect(moved).not.toBeNull();
      expect(moved!.parentId!.value).toBe(newParentId.value);
    });

    it('throws when saving a second FileNode with the same path in the same project', async () => {
      const repo = new InMemoryFileNodeRepository();
      const differentId = FileNodeId.create('550e8400-e29b-41d4-a716-446655440099');
      await repo.save(new FileNode(fileNodeId, projectId, null, 'root', FileNodeType.create('folder'), FilePath.create('/')));
      await expect(
        repo.save(new FileNode(differentId, projectId, null, 'root2', FileNodeType.create('folder'), FilePath.create('/')))
      ).rejects.toThrow();
    });

    it('allows the same path in different projects', async () => {
      const repo = new InMemoryFileNodeRepository();
      await repo.save(new FileNode(fileNodeId, projectId, null, 'root', FileNodeType.create('folder'), FilePath.create('/')));
      await expect(
        repo.save(new FileNode(fileNodeId2, projectId2, null, 'root', FileNodeType.create('folder'), FilePath.create('/')))
      ).resolves.toBeUndefined();
    });
  });

  describe('InMemoryDocumentRepository', () => {
    it('saves and retrieves by id', async () => {
      const repo = new InMemoryDocumentRepository();
      const document = new Document(
        documentId, fileNodeId,
        ContentId.create('550e8400-e29b-41d4-a716-446655440080'),
        YjsStateId.create('550e8400-e29b-41d4-a716-446655440081'),
        MimeType.create('text/asciidoc'),
      );
      await repo.save(document);
      const found = await repo.findById(documentId);
      expect(found).not.toBeNull();
    });

    it('finds by file node id', async () => {
      const repo = new InMemoryDocumentRepository();
      const document = new Document(
        documentId, fileNodeId,
        ContentId.create('550e8400-e29b-41d4-a716-446655440080'),
        YjsStateId.create('550e8400-e29b-41d4-a716-446655440081'),
        MimeType.create('text/asciidoc'),
      );
      await repo.save(document);
      const found = await repo.findByFileNodeId(fileNodeId);
      expect(found).not.toBeNull();
    });
  });

  describe('InMemoryProjectMemberRepository', () => {
    it('adds and retrieves by composite key', async () => {
      const repo = new InMemoryProjectMemberRepository();
      const member = new ProjectMember(projectId, userId, Role.create('viewer'));
      await repo.addMember(member);
      const found = await repo.findByCompositeKey(projectId, userId);
      expect(found).not.toBeNull();
      expect(found!.role.value).toBe('viewer');
    });

    it('finds by project id', async () => {
      const repo = new InMemoryProjectMemberRepository();
      await repo.addMember(new ProjectMember(projectId, userId, Role.create('viewer')));
      await repo.addMember(new ProjectMember(projectId, userId2, Role.create('editor')));
      const members = await repo.findByProjectId(projectId);
      expect(members).toHaveLength(2);
    });

    it('removes a member', async () => {
      const repo = new InMemoryProjectMemberRepository();
      await repo.addMember(new ProjectMember(projectId, userId, Role.create('viewer')));
      await repo.removeMember(projectId, userId);
      const found = await repo.findByCompositeKey(projectId, userId);
      expect(found).toBeNull();
    });

    it('updates role', async () => {
      const repo = new InMemoryProjectMemberRepository();
      await repo.addMember(new ProjectMember(projectId, userId, Role.create('viewer')));
      await repo.updateRole(projectId, userId, Role.create('editor'));
      const found = await repo.findByCompositeKey(projectId, userId);
      expect(found!.role.value).toBe('editor');
    });
  });

  describe('InMemoryGitRepositoryRepository', () => {
    it('saves and retrieves by id', async () => {
      const repo = new InMemoryGitRepositoryRepository();
      const gr = new GitRepository(gitRepoId, projectId, GitProvider.create('github'), 'https://github.com/test/repo', 'cred-1');
      await repo.save(gr);
      const found = await repo.findById(gitRepoId);
      expect(found).not.toBeNull();
    });

    it('finds by project id', async () => {
      const repo = new InMemoryGitRepositoryRepository();
      const gr = new GitRepository(gitRepoId, projectId, GitProvider.create('github'), 'https://github.com/test/repo', 'cred-1');
      await repo.save(gr);
      const found = await repo.findByProjectId(projectId);
      expect(found).not.toBeNull();
    });
  });

  describe('InMemoryTemplateRepository', () => {
    it('saves and retrieves by id', async () => {
      const repo = new InMemoryTemplateRepository();
      const tpl = new Template(templateId, 'API Docs', null, TemplateCategory.create('documentation'), null);
      await repo.save(tpl);
      const found = await repo.findById(templateId);
      expect(found).not.toBeNull();
    });

    it('returns all templates', async () => {
      const repo = new InMemoryTemplateRepository();
      await repo.save(new Template(templateId, 'T1', null, TemplateCategory.create('doc'), null));
      await repo.save(new Template(TemplateId.create('550e8400-e29b-41d4-a716-446655440051'), 'T2', null, TemplateCategory.create('guide'), null));
      const all = await repo.findAll();
      expect(all).toHaveLength(2);
    });
  });

  describe('InMemoryAssetRepository', () => {
    it('saves and retrieves by FileNode id', async () => {
      const repo = new InMemoryAssetRepository();
      const asset = new Asset(fileNodeId, MimeType.create('image/png'), 1024n);
      await repo.save(asset);
      const found = await repo.findById(fileNodeId);
      expect(found).not.toBeNull();
      expect(found!.id.value).toBe(fileNodeId.value);
    });

    it('returns null when no asset exists for the given FileNode id', async () => {
      const repo = new InMemoryAssetRepository();
      const result = await repo.findById(fileNodeId);
      expect(result).toBeNull();
    });

    it('deletes an asset', async () => {
      const repo = new InMemoryAssetRepository();
      await repo.save(new Asset(fileNodeId, MimeType.create('image/png'), 100n));
      await repo.delete(fileNodeId);
      expect(await repo.findById(fileNodeId)).toBeNull();
    });

    it('throws when saving a second asset for the same FileNode id (1:1 FK constraint)', async () => {
      const repo = new InMemoryAssetRepository();
      const sameDate = new Date('2024-03-15T12:00:00Z');
      // Two assets share the same storagePath iff they reference the same FileNode (same id).
      // The second save must fail, mirroring the PK uniqueness constraint.
      await repo.save(new Asset(fileNodeId, MimeType.create('image/png'), 100n, sameDate));
      await expect(
        repo.save(new Asset(fileNodeId, MimeType.create('image/jpeg'), 200n, sameDate))
      ).rejects.toThrow();
    });
  });

  describe('InMemoryActiveCloneRegistry', () => {
    it('grants the first acquisition for a user', () => {
      const registry = new InMemoryActiveCloneRegistry();
      expect(registry.tryAcquire(userId)).toBe(true);
    });

    it('refuses a second acquisition until the first is released', () => {
      const registry = new InMemoryActiveCloneRegistry();
      registry.tryAcquire(userId);
      expect(registry.tryAcquire(userId)).toBe(false);
      registry.release(userId);
      expect(registry.tryAcquire(userId)).toBe(true);
    });

    it('keeps users independent of one another', () => {
      const registry = new InMemoryActiveCloneRegistry();
      expect(registry.tryAcquire(userId)).toBe(true);
      expect(registry.tryAcquire(userId2)).toBe(true);
      registry.release(userId);
      expect(registry.tryAcquire(userId2)).toBe(false);
    });

    it('treats releasing a user who holds nothing as a no-op', () => {
      const registry = new InMemoryActiveCloneRegistry();
      expect(() => registry.release(userId)).not.toThrow();
      expect(registry.tryAcquire(userId)).toBe(true);
    });

    it('keys holders by id value rather than by instance identity', () => {
      const registry = new InMemoryActiveCloneRegistry();
      registry.tryAcquire(UserId.create(userId.value));
      expect(registry.tryAcquire(UserId.create(userId.value))).toBe(false);
    });

    it('does not share held users between instances', () => {
      const first = new InMemoryActiveCloneRegistry();
      first.tryAcquire(userId);
      expect(new InMemoryActiveCloneRegistry().tryAcquire(userId)).toBe(true);
    });
  });

  describe('InMemoryAuditLogRepository', () => {
    it('saves and finds all', async () => {
      const repo = new InMemoryAuditLogRepository();
      const log = new AuditLog(auditLogId, userId, projectId, 'project.created', 'Project', projectId.value);
      await repo.save(log);
      const all = await repo.findAll();
      expect(all).toHaveLength(1);
    });

    it('finds by project id', async () => {
      const repo = new InMemoryAuditLogRepository();
      await repo.save(new AuditLog(auditLogId, userId, projectId, 'project.created', 'Project', projectId.value));
      const logs = await repo.findByProjectId(projectId);
      expect(logs).toHaveLength(1);
    });

    it('finds by user id', async () => {
      const repo = new InMemoryAuditLogRepository();
      await repo.save(new AuditLog(auditLogId, userId, projectId, 'project.created', 'Project', projectId.value));
      const logs = await repo.findByUserId(userId);
      expect(logs).toHaveLength(1);
    });
  });
});
