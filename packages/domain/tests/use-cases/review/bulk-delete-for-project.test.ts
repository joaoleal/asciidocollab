import { BulkDeleteForProjectUseCase } from '../../../src/use-cases/review/bulk-delete-for-project';
import { InMemoryReviewCommentRepository } from '../../ports/review/in-memory-review-comment.repository';
import { InMemoryProjectMemberRepository } from '../../ports/project/in-memory-project-member.repository';
import { InMemoryAuditLogRepository } from '../../ports/admin/in-memory-audit-log.repository';
import { ReviewComment } from '../../../src/entities/review-comment';
import { ReviewAnchor } from '../../../src/value-objects/review/review-anchor';
import { ProjectMember } from '../../../src/entities/project-member';
import { Role } from '../../../src/value-objects/identity/role';
import { ReviewCommentId } from '../../../src/value-objects/ids/review-comment-id';
import { ProjectId } from '../../../src/value-objects/ids/project-id';
import { DocumentId } from '../../../src/value-objects/ids/document-id';
import { UserId } from '../../../src/value-objects/ids/user-id';
import { PermissionDeniedError } from '../../../src/errors/common/permission-denied';
import { ValidationError } from '../../../src/errors/common/validation-error';
import { ReviewCountConflictError } from '../../../src/errors/review/review-count-conflict';
import { AUDIT_REVIEW_PROJECT_CLEARED } from '../../../src/audit-actions';
import type { BulkDeleteForProjectCommand } from '../../../src/use-cases/review/bulk-delete-for-project';

const PROJECT = ProjectId.create('11111111-1111-4111-8111-111111111111');
const DOC_A = DocumentId.create('22222222-2222-4222-8222-222222222222');
const DOC_B = DocumentId.create('88888888-8888-4888-8888-888888888888');
const OWNER = UserId.create('55555555-5555-4555-8555-555555555555');
const EDITOR = UserId.create('66666666-6666-4666-8666-666666666666');
const OUTSIDER = UserId.create('77777777-7777-4777-8777-777777777777');

const confirmed: BulkDeleteForProjectCommand = { confirm: true };

function anchor(): ReviewAnchor {
  return new ReviewAnchor(null, { prefix: '', exact: 'passage', suffix: '' }, 1, null, 'located');
}

function rootOn(id: string, documentId: DocumentId): ReviewComment {
  return new ReviewComment(
    ReviewCommentId.create(id), PROJECT, documentId, null, 'comment', 'body', OWNER,
    null, null, null, null, null, anchor(),
  );
}

describe('BulkDeleteForProjectUseCase', () => {
  let reviewRepo: InMemoryReviewCommentRepository;
  let memberRepo: InMemoryProjectMemberRepository;
  let auditRepo: InMemoryAuditLogRepository;
  let useCase: BulkDeleteForProjectUseCase;

  beforeEach(async () => {
    reviewRepo = new InMemoryReviewCommentRepository();
    memberRepo = new InMemoryProjectMemberRepository();
    auditRepo = new InMemoryAuditLogRepository();
    useCase = new BulkDeleteForProjectUseCase(reviewRepo, memberRepo, auditRepo);
    await memberRepo.addMember(new ProjectMember(PROJECT, OWNER, Role.create('owner'), new Date()));
    await memberRepo.addMember(new ProjectMember(PROJECT, EDITOR, Role.create('editor'), new Date()));
    await reviewRepo.create(rootOn('33333333-3333-4333-8333-333333333333', DOC_A));
    await reviewRepo.create(rootOn('44444444-4444-4444-8444-444444444444', DOC_B));
  });

  test('the owner clears the whole project, with an audit entry', async () => {
    const result = await useCase.execute(OWNER, PROJECT, confirmed);
    expect(result.success).toBe(true);
    if (result.success) expect(result.value.deleted).toBe(2);
    expect(await reviewRepo.countByProject(PROJECT)).toBe(0);
    const audits = await auditRepo.findByProjectId(PROJECT);
    expect(audits.some((a) => a.action === AUDIT_REVIEW_PROJECT_CLEARED)).toBe(true);
  });

  test('a non-owner editor is denied and the denial is audited', async () => {
    expect.assertions(4);
    const result = await useCase.execute(EDITOR, PROJECT, confirmed);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBeInstanceOf(PermissionDeniedError);
    expect(await reviewRepo.countByProject(PROJECT)).toBe(2);
    const audits = await auditRepo.findByProjectId(PROJECT);
    expect(audits.some((a) => a.action === 'authz.denied')).toBe(true);
  });

  test('the delete is idempotent — a repeat removes 0', async () => {
    await useCase.execute(OWNER, PROJECT, confirmed);
    const second = await useCase.execute(OWNER, PROJECT, confirmed);
    expect(second.success).toBe(true);
    if (second.success) expect(second.value.deleted).toBe(0);
  });

  test('a stale expectedCount is rejected as a count conflict', async () => {
    const result = await useCase.execute(OWNER, PROJECT, { confirm: true, expectedCount: 9 });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBeInstanceOf(ReviewCountConflictError);
    expect(await reviewRepo.countByProject(PROJECT)).toBe(2);
  });

  test('an expectedCount matching the live count lets the delete proceed', async () => {
    const result = await useCase.execute(OWNER, PROJECT, { confirm: true, expectedCount: 2 });
    expect(result.success).toBe(true);
    if (result.success) expect(result.value.deleted).toBe(2);
    expect(await reviewRepo.countByProject(PROJECT)).toBe(0);
  });

  test('a non-member is denied and the denial names the missing membership', async () => {
    const result = await useCase.execute(OUTSIDER, PROJECT, confirmed);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBeInstanceOf(PermissionDeniedError);
    expect(await reviewRepo.countByProject(PROJECT)).toBe(2);
    const audits = await auditRepo.findByProjectId(PROJECT);
    const denial = audits.find((a) => a.action === 'authz.denied');
    expect(denial?.metadata.reason).toBe('not_a_project_member');
  });

  test('an unconfirmed command is rejected', async () => {
    const result = await useCase.execute(OWNER, PROJECT, { confirm: false } as unknown as BulkDeleteForProjectCommand);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBeInstanceOf(ValidationError);
  });
});
