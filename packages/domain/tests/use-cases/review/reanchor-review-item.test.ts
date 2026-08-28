import { ReanchorReviewItemUseCase } from '../../../src/use-cases/review/reanchor-review-item';
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
import { ReviewItemNotFoundError } from '../../../src/errors/review/review-item-not-found';
import { AnchorInvalidError } from '../../../src/errors/review/anchor-invalid';
import { ReviewOperationInvalidError } from '../../../src/errors/review/review-operation-invalid';
import { AUDIT_REVIEW_REANCHORED } from '../../../src/audit-actions';
import type { ReanchorReviewItemCommand } from '../../../src/use-cases/review/reanchor-review-item';

const PROJECT = ProjectId.create('11111111-1111-4111-8111-111111111111');
const DOCUMENT = DocumentId.create('22222222-2222-4222-8222-222222222222');
const ROOT = ReviewCommentId.create('33333333-3333-4333-8333-333333333333');
const REPLY = ReviewCommentId.create('44444444-4444-4444-8444-444444444444');
const EDITOR = UserId.create('55555555-5555-4555-8555-555555555555');
const VIEWER = UserId.create('66666666-6666-4666-8666-666666666666');
const MISSING = ReviewCommentId.create('77777777-7777-4777-8777-777777777777');

function command(overrides: Partial<ReanchorReviewItemCommand['anchor']> = {}): ReanchorReviewItemCommand {
  return {
    anchor: {
      relPos: new Uint8Array([1, 2, 3]),
      quote: { prefix: 'a ', exact: 'new passage', suffix: ' b' },
      lineHint: 7,
      sectionId: 'sec-1',
      ...overrides,
    },
  };
}

/** A root whose anchor has degraded to its enclosing section. */
function sectionRoot(): ReviewComment {
  const anchor = new ReviewAnchor(null, { prefix: '', exact: 'old', suffix: '' }, 1, 'sec-old', 'section');
  return new ReviewComment(ROOT, PROJECT, DOCUMENT, null, 'comment', 'a root', EDITOR, null, null, null, null, null, anchor);
}

function reply(): ReviewComment {
  return new ReviewComment(REPLY, PROJECT, DOCUMENT, ROOT, 'comment', 'a reply', EDITOR);
}

/** A root whose reanchor fails with an error the use case is not meant to translate. */
class UnexpectedlyFailingRoot extends ReviewComment {
  override reanchor(): void {
    throw new TypeError('aggregate blew up');
  }
}

describe('ReanchorReviewItemUseCase', () => {
  let reviewRepo: InMemoryReviewCommentRepository;
  let memberRepo: InMemoryProjectMemberRepository;
  let auditRepo: InMemoryAuditLogRepository;
  let useCase: ReanchorReviewItemUseCase;

  beforeEach(async () => {
    reviewRepo = new InMemoryReviewCommentRepository();
    memberRepo = new InMemoryProjectMemberRepository();
    auditRepo = new InMemoryAuditLogRepository();
    useCase = new ReanchorReviewItemUseCase(reviewRepo, memberRepo, auditRepo);
    await memberRepo.addMember(new ProjectMember(PROJECT, EDITOR, Role.create('editor'), new Date()));
    await memberRepo.addMember(new ProjectMember(PROJECT, VIEWER, Role.create('viewer'), new Date()));
    await reviewRepo.create(sectionRoot());
    await reviewRepo.create(reply());
  });

  test('a section-pinned item becomes located after reanchor, with an audit entry', async () => {
    const result = await useCase.execute(EDITOR, PROJECT, ROOT, command());
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.value.item.anchor?.state).toBe('located');
      expect(result.value.item.anchor?.quote?.exact).toBe('new passage');
    }
    const stored = await reviewRepo.findById(PROJECT, ROOT);
    expect(stored?.anchor?.state).toBe('located');
    const audits = await auditRepo.findByProjectId(PROJECT);
    expect(audits.some((a) => a.action === AUDIT_REVIEW_REANCHORED)).toBe(true);
  });

  test('a viewer is denied and the denial is audited', async () => {
    expect.assertions(3);
    const result = await useCase.execute(VIEWER, PROJECT, ROOT, command());
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBeInstanceOf(PermissionDeniedError);
    const audits = await auditRepo.findByProjectId(PROJECT);
    expect(audits.some((a) => a.action === 'authz.denied')).toBe(true);
  });

  test('a missing item returns a not-found error', async () => {
    const result = await useCase.execute(EDITOR, PROJECT, MISSING, command());
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBeInstanceOf(ReviewItemNotFoundError);
  });

  test('an empty quote passage is rejected as an invalid anchor', async () => {
    const result = await useCase.execute(EDITOR, PROJECT, ROOT, command({ quote: { prefix: '', exact: '   ', suffix: '' } }));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBeInstanceOf(AnchorInvalidError);
  });

  test('an unexpected aggregate failure is not translated into a result error', async () => {
    const anchor = new ReviewAnchor(null, { prefix: '', exact: 'old', suffix: '' }, 1, 'sec-old', 'section');
    await reviewRepo.update(
      new UnexpectedlyFailingRoot(ROOT, PROJECT, DOCUMENT, null, 'comment', 'a root', EDITOR, null, null, null, null, null, anchor),
    );
    await expect(useCase.execute(EDITOR, PROJECT, ROOT, command())).rejects.toThrow('aggregate blew up');
  });

  test('reanchoring a reply is rejected as an invalid operation', async () => {
    const result = await useCase.execute(EDITOR, PROJECT, REPLY, command());
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBeInstanceOf(ReviewOperationInvalidError);
  });
});
