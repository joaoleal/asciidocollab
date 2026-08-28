// The review module is consumed through its barrel, so a symbol dropped or renamed behind it would
// only surface at an import site far away. Reading every export through the barrel keeps that
// contract honest.
import {
  ReviewViewStateProvider,
  useReviewViewState,
  useReviewViewStateOptional,
  ReactionBar,
  ReviewThreadCard,
  ReviewAvatar,
  CommentComposer,
  CommentRail,
  ReviewTaskControls,
  TaskPanel,
  DetachedTray,
  DeleteItemAction,
  BulkDeleteDocumentAction,
  ProjectBulkDeleteButton,
} from '@/components/review';
import * as viewState from '@/components/review/view-state';
import * as threadCard from '@/components/review/thread-card';

describe('review module barrel', () => {
  test('exposes the view-state provider and both of its hooks', () => {
    expect(typeof ReviewViewStateProvider).toBe('function');
    expect(typeof useReviewViewState).toBe('function');
    expect(typeof useReviewViewStateOptional).toBe('function');
  });

  test('exposes the comment-rail surface components', () => {
    expect(typeof ReactionBar).toBe('function');
    expect(typeof ReviewThreadCard).toBe('function');
    expect(typeof ReviewAvatar).toBe('function');
    expect(typeof CommentComposer).toBe('function');
    expect(typeof CommentRail).toBe('function');
    expect(typeof DetachedTray).toBe('function');
  });

  test('exposes the task surface components', () => {
    expect(typeof ReviewTaskControls).toBe('function');
    expect(typeof TaskPanel).toBe('function');
  });

  test('exposes every delete control', () => {
    expect(typeof DeleteItemAction).toBe('function');
    expect(typeof BulkDeleteDocumentAction).toBe('function');
    expect(typeof ProjectBulkDeleteButton).toBe('function');
  });

  test('re-exports the very same bindings the underlying modules define', () => {
    expect(useReviewViewState).toBe(viewState.useReviewViewState);
    expect(ReviewViewStateProvider).toBe(viewState.ReviewViewStateProvider);
    expect(useReviewViewStateOptional).toBe(viewState.useReviewViewStateOptional);
    expect(ReviewThreadCard).toBe(threadCard.ReviewThreadCard);
    expect(ReviewAvatar).toBe(threadCard.ReviewAvatar);
  });
});
