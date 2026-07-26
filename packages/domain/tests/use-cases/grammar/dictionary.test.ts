import { AddDictionaryTermUseCase } from '../../../src/use-cases/grammar/add-dictionary-term';
import { RemoveDictionaryTermUseCase } from '../../../src/use-cases/grammar/remove-dictionary-term';
import { ListDictionaryTermsUseCase } from '../../../src/use-cases/grammar/list-dictionary-terms';
import { InMemoryProjectDictionaryRepository } from '../../ports/grammar/in-memory-project-dictionary.repository';
import { InMemoryProjectMemberRepository } from '../../ports/project/in-memory-project-member.repository';
import { InMemoryAuditLogRepository } from '../../ports/admin/in-memory-audit-log.repository';
import { ProjectMember } from '../../../src/entities/project-member';
import { Role } from '../../../src/value-objects/identity/role';
import { ProjectId } from '../../../src/value-objects/ids/project-id';
import { UserId } from '../../../src/value-objects/ids/user-id';
import { ProjectDictionaryTermId } from '../../../src/value-objects/ids/project-dictionary-term-id';
import { ProjectDictionaryTerm } from '../../../src/entities/project-dictionary-term';
import { PermissionDeniedError } from '../../../src/errors/common/permission-denied';
import { DictionaryTermNotFoundError } from '../../../src/errors/grammar/dictionary-term-not-found';
import { AUDIT_DICTIONARY_TERM_ADDED } from '../../../src/audit-actions';

const PROJECT = ProjectId.create('11111111-1111-4111-8111-111111111111');
const OWNER = UserId.create('44444444-4444-4444-8444-444444444444');
const EDITOR = UserId.create('55555555-5555-4555-8555-555555555555');
const VIEWER = UserId.create('66666666-6666-4666-8666-666666666666');
const OUTSIDER = UserId.create('77777777-7777-4777-8777-777777777777');

describe('Project dictionary use cases', () => {
  let repo: InMemoryProjectDictionaryRepository;
  let memberRepo: InMemoryProjectMemberRepository;
  let auditRepo: InMemoryAuditLogRepository;
  let add: AddDictionaryTermUseCase;
  let remove: RemoveDictionaryTermUseCase;
  let list: ListDictionaryTermsUseCase;

  beforeEach(async () => {
    repo = new InMemoryProjectDictionaryRepository();
    memberRepo = new InMemoryProjectMemberRepository();
    auditRepo = new InMemoryAuditLogRepository();
    await memberRepo.addMember(new ProjectMember(PROJECT, OWNER, Role.create('owner'), new Date()));
    await memberRepo.addMember(new ProjectMember(PROJECT, EDITOR, Role.create('editor'), new Date()));
    await memberRepo.addMember(new ProjectMember(PROJECT, VIEWER, Role.create('viewer'), new Date()));
    add = new AddDictionaryTermUseCase(repo, memberRepo, auditRepo);
    remove = new RemoveDictionaryTermUseCase(repo, memberRepo, auditRepo);
    list = new ListDictionaryTermsUseCase(repo, memberRepo);
  });

  describe('add', () => {
    it('adds a term for an editor and audits it', async () => {
      const result = await add.execute(EDITOR, PROJECT, 'Kubernetes');
      expect(result.success).toBe(true);
      const stored = await repo.listByProject(PROJECT);
      expect(stored.map((t) => t.term)).toEqual(['Kubernetes']);
      const audits = await auditRepo.findByProjectId(PROJECT);
      expect(audits.some((a) => a.action === AUDIT_DICTIONARY_TERM_ADDED)).toBe(true);
    });

    it('is idempotent on a case-insensitive duplicate (returns the existing term, no second row)', async () => {
      const first = await add.execute(EDITOR, PROJECT, 'API');
      const second = await add.execute(OWNER, PROJECT, 'api');
      expect(first.success && second.success).toBe(true);
      if (first.success && second.success) expect(second.value.id.value).toBe(first.value.id.value);
      expect(await repo.listByProject(PROJECT)).toHaveLength(1);
    });

    it('LOOK-ALIKE GUARD: accepting a term does not suppress a genuinely different misspelling that resembles it', async () => {
      // Accepting "API" must NOT make "APl" (lowercase L, a different string) a known term.
      await add.execute(EDITOR, PROJECT, 'API');
      expect(await repo.findByTerm(PROJECT, 'APl')).toBeNull();
      const stored = await repo.listByProject(PROJECT);
      expect(stored.map((t) => t.term)).toEqual(['API']);
    });

    it('denies a viewer and an outsider', async () => {
      const viewerResult = await add.execute(VIEWER, PROJECT, 'x');
      const outsiderResult = await add.execute(OUTSIDER, PROJECT, 'x');
      expect(viewerResult.error).toBeInstanceOf(PermissionDeniedError);
      expect(outsiderResult.error).toBeInstanceOf(PermissionDeniedError);
      expect(await repo.listByProject(PROJECT)).toHaveLength(0);
    });

    it('resolves a concurrent add that lost the unique-constraint race to the existing term (no 500)', async () => {
      const existing = new ProjectDictionaryTerm(
        ProjectDictionaryTermId.create('99999999-9999-4999-8999-999999999999'),
        PROJECT,
        'Kubernetes',
        OWNER,
      );
      // The pre-check misses; a concurrent writer commits the same term; our add then loses on the
      // unique (project, term) constraint; the retry lookup now sees the winner.
      const findSpy = jest
        .spyOn(repo, 'findByTerm')
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(existing);
      jest.spyOn(repo, 'add').mockRejectedValueOnce(new Error('unique constraint violation'));

      const result = await add.execute(EDITOR, PROJECT, 'Kubernetes');

      expect(result.success).toBe(true);
      if (result.success) expect(result.value.id.value).toBe(existing.id.value);
      expect(findSpy).toHaveBeenCalledTimes(2); // pre-check miss, then the post-conflict re-read
    });

    it('rethrows a genuine add failure when no racing term exists', async () => {
      jest.spyOn(repo, 'findByTerm').mockResolvedValue(null);
      jest.spyOn(repo, 'add').mockRejectedValueOnce(new Error('database unavailable'));
      await expect(add.execute(EDITOR, PROJECT, 'Kubernetes')).rejects.toThrow('database unavailable');
    });
  });

  describe('remove', () => {
    it('removes an existing term for an editor', async () => {
      const added = await add.execute(EDITOR, PROJECT, 'Kubernetes');
      if (!added.success) throw new Error('setup failed');
      const result = await remove.execute(EDITOR, PROJECT, added.value.id);
      expect(result.success).toBe(true);
      expect(await repo.listByProject(PROJECT)).toHaveLength(0);
    });

    it('returns not-found when removing a term that does not exist', async () => {
      const result = await remove.execute(EDITOR, PROJECT, ProjectDictionaryTermId.create('88888888-8888-4888-8888-888888888888'));
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error).toBeInstanceOf(DictionaryTermNotFoundError);
    });

    it('denies a viewer', async () => {
      const added = await add.execute(EDITOR, PROJECT, 'Kubernetes');
      if (!added.success) throw new Error('setup failed');
      const result = await remove.execute(VIEWER, PROJECT, added.value.id);
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error).toBeInstanceOf(PermissionDeniedError);
    });
  });

  describe('list', () => {
    it('returns the terms for any member', async () => {
      await add.execute(EDITOR, PROJECT, 'Kubernetes');
      const result = await list.execute(VIEWER, PROJECT);
      expect(result.success).toBe(true);
      if (result.success) expect(result.value.map((t) => t.term)).toEqual(['Kubernetes']);
    });

    it('denies an outsider', async () => {
      const result = await list.execute(OUTSIDER, PROJECT);
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error).toBeInstanceOf(PermissionDeniedError);
    });
  });
});
