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

/**
 * The `GitOperationKind`s that replace working-tree content once active, as opposed to kinds that
 * only touch remote-connection metadata (`CONNECT`/`DISCONNECT`), leave working files untouched
 * (`PUSH`/`FETCH`/`BRANCH_CREATE`), or are short guard-only ops that acquire and release
 * `withGuard` too quickly to ever be observed as a durable active operation
 * (`COMMIT`/`RESOLVE`/`DISCARD`/`AMEND`).
 *
 * The write-lock — file-tree mutation routes and new collaboration/edit sessions — blocks only
 * while one of these is active for a project; every other kind, and every read-only operation
 * (which never becomes a `GitOperation` row at all), never trips it.
 */
export const CONTENT_CHANGING_GIT_OPERATION_KINDS: readonly GitOperationKind[] = ['IMPORT', 'PULL', 'BRANCH_SWITCH'];
