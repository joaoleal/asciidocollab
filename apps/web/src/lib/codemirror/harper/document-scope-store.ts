import type { IncludedFileIssue } from './included-file-lint';

/**
 * The channel carrying the "Whole document" pass's result from the editor mount (which owns the worker
 * client and the include tree) to the Writing panel (which lists it).
 *
 * It is a subscribable module store rather than a prop chain because the two ends are siblings: the
 * editor and the Writing panel share no ancestor that carries checker state, and there is exactly one
 * mounted editor at a time (the editor remounts per opened file, resetting this along with it). The
 * store holds one frozen snapshot so `useSyncExternalStore` sees a stable identity between changes.
 *
 * Cross-file issues stay OUT of the editor's own diagnostic list on purpose. Those diagnostics carry
 * live document positions and drive underlines and one-click fixes; an issue in another file has no
 * position here, so folding it in would put a fix chip on text this editor could corrupt.
 */

/** What the "Whole document" pass currently has to say. */
export type DocumentScopeState =
  /** The panel is scoped to this file (or the checker is off) — nothing cross-file to report. */
  | 'inactive'
  /** The pass is running over the other files of the include tree. */
  | 'scanning'
  /** The pass finished; `issues` is complete for the file set it covered. */
  | 'checked'
  /**
   * The pass ran out of attempts without finishing — continuous editing keeps superseding it, since
   * the open file's own lint shares the worker and wins. `issues` holds whatever the last attempt
   * did reach, which is a partial list and is labelled as one. This state exists so the panel can
   * stop claiming to still be working: without it the pass simply never published and the reader was
   * left watching "Checking N other files…" forever.
   */
  | 'incomplete'
  /** Whole-document scope is on, but this file pulls in no other file — it IS the whole document. */
  | 'alone'
  /** This file is not part of the configured main document, so that document is not the one being edited. */
  | 'outside-main';

/** The Writing panel's view of the cross-file pass. */
export interface DocumentScopeSnapshot {
  /** What the pass currently has to say. */
  readonly state: DocumentScopeState;
  /** How many other files the pass covers (0 unless `scanning`, `checked` or `incomplete`). */
  readonly fileCount: number;
  /** The issues found in those files, in file order. */
  readonly issues: readonly IncludedFileIssue[];
  /** Opens an issue's file at its line, or null when navigation is unavailable. */
  readonly reveal: ((issue: IncludedFileIssue) => void) | null;
}

/** The resting snapshot: no cross-file pass is running or has anything to report. */
const INACTIVE: DocumentScopeSnapshot = Object.freeze({
  state: 'inactive',
  fileCount: 0,
  issues: Object.freeze([]),
  reveal: null,
});

let snapshot: DocumentScopeSnapshot = INACTIVE;
const listeners = new Set<() => void>();

/**
 * Subscribe to cross-file pass changes (the `useSyncExternalStore` subscribe function).
 *
 * @param listener - Called after every published change.
 * @returns The unsubscribe function.
 */
export function subscribeDocumentScope(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Read the current cross-file snapshot. Identity-stable until something is published, as
 * `useSyncExternalStore` requires.
 *
 * @returns The current snapshot.
 */
export function getDocumentScopeSnapshot(): DocumentScopeSnapshot {
  return snapshot;
}

/**
 * Publish a new cross-file snapshot to the Writing panel.
 *
 * @param next - The snapshot to publish.
 */
export function setDocumentScope(next: DocumentScopeSnapshot): void {
  snapshot = Object.freeze(next);
  for (const listener of listeners) listener();
}

/** Return the store to rest — the scope went back to this file, or the editor unmounted. */
export function resetDocumentScope(): void {
  if (snapshot === INACTIVE) return;
  snapshot = INACTIVE;
  for (const listener of listeners) listener();
}
