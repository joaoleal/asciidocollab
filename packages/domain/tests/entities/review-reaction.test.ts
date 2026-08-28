import { ReviewReaction } from '../../src/entities/review-reaction';
import { ReviewReactionId } from '../../src/value-objects/ids/review-reaction-id';
import { ReviewCommentId } from '../../src/value-objects/ids/review-comment-id';
import { UserId } from '../../src/value-objects/ids/user-id';

const REACTION = ReviewReactionId.create('11111111-1111-4111-8111-111111111111');
const ITEM = ReviewCommentId.create('22222222-2222-4222-8222-222222222222');
const USER = UserId.create('33333333-3333-4333-8333-333333333333');

describe('ReviewReaction', () => {
  it('records which user reacted to which item with which emoji', () => {
    const reaction = new ReviewReaction(REACTION, ITEM, USER, '👍');

    expect(reaction.id).toBe(REACTION);
    expect(reaction.reviewCommentId).toBe(ITEM);
    expect(reaction.userId).toBe(USER);
    expect(reaction.emoji).toBe('👍');
  });

  it('rejects an empty emoji key', () => {
    expect(() => new ReviewReaction(REACTION, ITEM, USER, '')).toThrow(
      'reaction emoji must be non-empty',
    );
  });

  it('defaults the creation date to now', () => {
    const before = Date.now();
    const reaction = new ReviewReaction(REACTION, ITEM, USER, '🎉');

    expect(reaction.createdAt.getTime()).toBeGreaterThanOrEqual(before);
  });

  it('hands out a defensive copy of the creation date', () => {
    const createdAt = new Date('2026-02-01T10:00:00.000Z');
    const reaction = new ReviewReaction(REACTION, ITEM, USER, '👍', createdAt);

    const first = reaction.createdAt;
    expect(first).toEqual(createdAt);
    expect(first).not.toBe(createdAt);

    first.setFullYear(1999);
    expect(reaction.createdAt).toEqual(createdAt);

    createdAt.setFullYear(1999);
    expect(reaction.createdAt.getUTCFullYear()).toBe(2026);
  });
});
