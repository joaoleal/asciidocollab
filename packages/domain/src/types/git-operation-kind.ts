/**
 * The kind of whole-project git action a `GitOperation` performs. Each mutating
 * git use case enqueues exactly one operation of the kind it represents.
 */
export type GitOperationKind =
  | 'IMPORT'
  | 'INITIALIZE'
  | 'CONNECT'
  | 'DISCONNECT'
  | 'COMMIT'
  | 'PUSH'
  | 'PULL'
  | 'FETCH'
  | 'BRANCH_CREATE'
  | 'BRANCH_SWITCH'
  | 'RESOLVE'
  | 'DISCARD'
  | 'AMEND'
  | 'UNDO_PULL';
