/** @file Barrel for the feature 038 review-comments UI module (US1–US5). */

export {
  ReviewViewStateProvider,
  useReviewViewState,
  useReviewViewStateOptional,
  type ReviewViewState,
} from './view-state';
export { ReactionBar, type ReactionBarProperties } from './reaction-bar';
export { ReviewThreadCard, ReviewAvatar, type ReviewThreadCardProperties } from './thread-card';
export {
  CommentComposer,
  type CommentComposerProperties,
  type NewCommentComposerProperties,
  type ReplyComposerProperties,
} from './composer';
export { CommentRail, type CommentRailProperties } from './comment-rail';
export { ReviewTaskControls, type ReviewTaskControlsProperties, type TaskMember } from './task-controls';
export {
  TaskPanel,
  type TaskPanelProperties,
  type TaskPanelDocument,
} from './task-panel';
export {
  DetachedTray,
  type DetachedTrayProperties,
  type DetachedTrayEntry,
} from './detached-tray';
export {
  DeleteItemAction,
  type DeleteItemActionProperties,
  BulkDeleteDocumentAction,
  type BulkDeleteDocumentActionProperties,
  ProjectBulkDeleteButton,
  type ProjectBulkDeleteButtonProperties,
} from './delete-controls';
