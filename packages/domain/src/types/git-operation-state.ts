/**
 * The lifecycle state of a `GitOperation`.
 *
 * ```
 * QUEUED ──▶ RUNNING ──▶ SUCCEEDED
 *              │  └────▶ AWAITING_CONFLICT ──▶ RUNNING (on resolve) ──▶ SUCCEEDED
 *              ├───────▶ FAILED   (typed error; project restored to its prior state)
 *              └───────▶ ABORTED  (user cancel / live-flush failure)
 * ```
 *
 * `QUEUED`, `RUNNING`, and `AWAITING_CONFLICT` are the **active** states: at most
 * one operation may be active for a given project at a time (the single-flight
 * guard). The remaining states are terminal.
 */
export type GitOperationState = 'QUEUED' | 'RUNNING' | 'AWAITING_CONFLICT' | 'SUCCEEDED' | 'FAILED' | 'ABORTED';

/** The operation states that count as "an operation is in progress" for a project. */
export const ACTIVE_GIT_OPERATION_STATES: readonly GitOperationState[] = ['QUEUED', 'RUNNING', 'AWAITING_CONFLICT'];

/** The terminal operation states: once reached, an operation never transitions again. */
export const TERMINAL_GIT_OPERATION_STATES: readonly GitOperationState[] = ['SUCCEEDED', 'FAILED', 'ABORTED'];
