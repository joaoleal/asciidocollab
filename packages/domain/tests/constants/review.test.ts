import {
  ANCHOR_STATES,
  REVIEW_BODY_MAX_LEN,
  REVIEW_ITEM_KINDS,
  REVIEW_ITEM_STATUSES,
  RESOLVED_TASK_STATUSES,
  isAnchorState,
  isReviewItemKind,
  isReviewItemStatus,
  isResolvedStatus,
} from '../../src/constants/review';

describe('review constants', () => {
  it('publishes a single body-length authority', () => {
    expect(REVIEW_BODY_MAX_LEN).toBe(4000);
  });

  it('lists the kinds, statuses and anchor states the domain recognises', () => {
    expect(REVIEW_ITEM_KINDS).toEqual(['comment', 'task']);
    expect(REVIEW_ITEM_STATUSES).toEqual(['open', 'in_progress', 'resolved', 'wontfix']);
    expect(ANCHOR_STATES).toEqual(['located', 'section', 'detached']);
    expect(RESOLVED_TASK_STATUSES).toEqual(['resolved', 'wontfix']);
  });
});

describe('isReviewItemKind', () => {
  it('accepts every declared kind', () => {
    for (const kind of REVIEW_ITEM_KINDS) {
      expect(isReviewItemKind(kind)).toBe(true);
    }
  });

  it('rejects an unknown token', () => {
    expect(isReviewItemKind('suggestion')).toBe(false);
    expect(isReviewItemKind('')).toBe(false);
    expect(isReviewItemKind('Comment')).toBe(false);
  });
});

describe('isReviewItemStatus', () => {
  it('accepts every declared status', () => {
    for (const status of REVIEW_ITEM_STATUSES) {
      expect(isReviewItemStatus(status)).toBe(true);
    }
  });

  it('rejects an unknown token', () => {
    expect(isReviewItemStatus('closed')).toBe(false);
    expect(isReviewItemStatus('')).toBe(false);
  });
});

describe('isAnchorState', () => {
  it('accepts every declared anchor state', () => {
    for (const state of ANCHOR_STATES) {
      expect(isAnchorState(state)).toBe(true);
    }
  });

  it('rejects an unknown token', () => {
    expect(isAnchorState('orphaned')).toBe(false);
    expect(isAnchorState('')).toBe(false);
  });
});

describe('isResolvedStatus', () => {
  it('treats resolved and wontfix as carrying a resolution stamp', () => {
    expect(isResolvedStatus('resolved')).toBe(true);
    expect(isResolvedStatus('wontfix')).toBe(true);
  });

  it('treats open and in-progress as unresolved', () => {
    expect(isResolvedStatus('open')).toBe(false);
    expect(isResolvedStatus('in_progress')).toBe(false);
  });
});
