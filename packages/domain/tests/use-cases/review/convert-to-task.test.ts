import { ConvertToTaskUseCase } from '../../../src/use-cases/review/convert-to-task';
import { InMemoryReviewCommentRepository } from '../../ports/review/in-memory-review-comment.repository';
import { InMemoryProjectMemberRepository } from '../../ports/project/in-memory-project-member.repository';
import { InMemoryAuditLogRepository } from '../../ports/admin/in-memory-audit-log.repository';
import { ProjectMember } from '../../../src/entities/project-member';
import { Role } from '../../../src/value-objects/identity/role';
import { ReviewComment } from '../../../src/entities/review-comment';
import { ReviewCommentId } from '../../../src/value-objects/ids/review-comment-id';
import { ProjectId } from '../../../src/value-objects/ids/project-id';
import { DocumentId } from '../../../src/value-objects/ids/document-id';
import { UserId } from '../../../src/value-objects/ids/user-id';
import { ReviewAnchor } from '../../../src/value-objects/review/review-anchor';
import { PermissionDeniedError } from '../../../src/errors/common/permission-denied';
import { ReviewItemNotFoundError } from '../../../src/errors/review/review-item-not-found';
import { ReviewOperationInvalidError } from '../../../src/errors/review/review-operation-invalid';
import { AUDIT_REVIEW_CONVERTED } from '../../../src/audit-actions';

const PROJECT = ProjectId.create('11111111-1111-4111-8111-111111111111');
const DOCUMENT = DocumentId.create('22222222-2222-4222-8222-222222222222');
const EDITOR = UserId.create('55555555-5555-4555-8555-555555555555');
const VIEWER = UserId.create('66666666-6666-4666-8666-666666666666');
const ASSIGNEE = UserId.create('77777777-7777-4777-8777-777777777777');
const COMMENT_ID = ReviewCommentId.create('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
const TASK_ID = ReviewCommentId.create('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
const REPLY_ID = ReviewCommentId.create('cccccccc-cccc-4ccc-8ccc-cccccccccccc');
const MISSING_ID = ReviewCommentId.create('dddddddd-dddd-4ddd-8ddd-dddddddddddd');

function anchor(): ReviewAnchor {
  return new ReviewAnchor(null, { prefix: 'a ', exact: 'passage', suffix: ' b' }, 3, null, 'located');
}

function rootComment(): ReviewComment {
  return new ReviewComment(COMMENT_ID, PROJECT, DOCUMENT, null, 'comment', 'body', EDITOR, null, null, null, null, null, anchor());
}

function rootTask(): ReviewComment {
  return new ReviewComment(TASK_ID, PROJECT, DOCUMENT, null, 'task', 'body', EDITOR, 'open', ASSIGNEE, new Date('2026-01-01'), null, null, anchor());
}

function reply(): ReviewComment {
  return new ReviewComment(REPLY_ID, PROJECT, DOCUMENT, COMMENT_ID, 'comment', 'a reply', EDITOR);
}

/** A comment whose promotion fails with an error the use case is not meant to translate. */
class UnexpectedlyFailingComment extends ReviewComment {
  override convertToTask(): void {
    throw new TypeError('aggregate blew up');
  }
}

describe('ConvertToTaskUseCase', () => {
  let reviewRepo: InMemoryReviewCommentRepository;
  let memberRepo: InMemoryProjectMemberRepository;
  let auditRepo: InMemoryAuditLogRepository;
  let useCase: ConvertToTaskUseCase;

  beforeEach(async () => {
    reviewRepo = new InMemoryReviewCommentRepository();
    memberRepo = new InMemoryProjectMemberRepository();
    auditRepo = new InMemoryAuditLogRepository();
    useCase = new ConvertToTaskUseCase(reviewRepo, memberRepo, auditRepo);
    await memberRepo.addMember(new ProjectMember(PROJECT, EDITOR, Role.create('editor'), new Date()));
    await memberRepo.addMember(new ProjectMember(PROJECT, VIEWER, Role.create('viewer'), new Date()));
  });

  test('an editor promotes a comment to a task defaulting to open and audits it', async () => {
    await reviewRepo.create(rootComment());
    const result = await useCase.execute(EDITOR, PROJECT, COMMENT_ID, { kind: 'task' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.value.item.isTask()).toBe(true);
      expect(result.value.item.status).toBe('open');
    }
    const audits = await auditRepo.findByProjectId(PROJECT);
    expect(audits.some((a) => a.action === AUDIT_REVIEW_CONVERTED)).toBe(true);
  });

  test('reverting a task to a comment clears status/assignee/dueDate but preserves author and anchor', async () => {
    await reviewRepo.create(rootTask());
    const result = await useCase.execute(EDITOR, PROJECT, TASK_ID, { kind: 'comment' });
    expect(result.success).toBe(true);
    if (result.success) {
      const item = result.value.item;
      expect(item.isComment()).toBe(true);
      expect(item.status).toBeNull();
      expect(item.assigneeId).toBeNull();
      expect(item.dueDate).toBeNull();
      expect(item.authorId?.equals(EDITOR)).toBe(true);
      expect(item.anchor?.state).toBe('located');
    }
  });

  test('a reply cannot be converted to a task', async () => {
    await reviewRepo.create(rootComment());
    await reviewRepo.create(reply());
    const result = await useCase.execute(EDITOR, PROJECT, REPLY_ID, { kind: 'task' });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBeInstanceOf(ReviewOperationInvalidError);
  });

  test('converting an item to the kind it already is is rejected', async () => {
    await reviewRepo.create(rootTask());
    const result = await useCase.execute(EDITOR, PROJECT, TASK_ID, { kind: 'task' });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBeInstanceOf(ReviewOperationInvalidError);
  });

  test('a viewer is denied and the denial is audited', async () => {
    await reviewRepo.create(rootComment());
    const result = await useCase.execute(VIEWER, PROJECT, COMMENT_ID, { kind: 'task' });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBeInstanceOf(PermissionDeniedError);
    const audits = await auditRepo.findByProjectId(PROJECT);
    expect(audits.some((a) => a.action === 'authz.denied')).toBe(true);
  });

  test('an unexpected aggregate failure is not translated into a result error', async () => {
    await reviewRepo.create(
      new UnexpectedlyFailingComment(COMMENT_ID, PROJECT, DOCUMENT, null, 'comment', 'body', EDITOR, null, null, null, null, null, anchor()),
    );
    await expect(useCase.execute(EDITOR, PROJECT, COMMENT_ID, { kind: 'task' })).rejects.toThrow('aggregate blew up');
  });

  test('a missing item yields a not-found error', async () => {
    const result = await useCase.execute(EDITOR, PROJECT, MISSING_ID, { kind: 'task' });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBeInstanceOf(ReviewItemNotFoundError);
  });
});
