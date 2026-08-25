import * as Y from 'yjs';
import type { Hocuspocus } from '@hocuspocus/server';
import {
  ProjectId,
  YjsStateId,
  computeMatches,
  selectSpans,
  type ContentReplacement,
  type YjsStateStore,
  type RegexEngine,
  type MatchBudget,
  type SearchQuery,
  type ReplaceSelection,
} from '@asciidocollab/domain';

/** The Y.Text name the CodeMirror binding (and persistence) uses for document content. */
const CODEMIRROR_TEXT = 'codemirror';

/**
 * In-transaction match budget for the structured apply. RE2 is linear-time, so
 * this is a generous safety bound, not a functional limit — the number of
 * confirmed selections is already small and client-bounded.
 */
const STRUCTURED_APPLY_BUDGET_MS = 1000;
const STRUCTURED_APPLY_MAX_MATCHES = 1_000_000;

/** A request to apply literal reference rewrites to one collaborative document. */
export interface ApplyEditsRequest {
  /** Project that owns the document. */
  projectId: string;
  /** Yjs state identifier — identifies the document's collaboration room. */
  yjsStateId: string;
  /** Literal find→replace deltas to apply to the document text. */
  replacements: ContentReplacement[];
}

/** A request to replace a live document's entire content with a target string via a minimal diff. */
export interface ApplyFullContentRequest {
  /** Project that owns the document. */
  projectId: string;
  /** Yjs state identifier — identifies the document's collaboration room. */
  yjsStateId: string;
  /** The content the document should end up containing. */
  content: string;
}

/** A request to read the live text of one collaborative document. */
export interface ReadContentRequest {
  /** Project that owns the document. */
  projectId: string;
  /** Yjs state identifier — identifies the document's collaboration room. */
  yjsStateId: string;
}

/**
 * Applies literal find→replace deltas to a Y.Text in place. MUST be called inside a Yjs
 * transaction. Every occurrence of each `find` is replaced; the string is re-read after each
 * splice so offsets stay valid, and the scan resumes past the inserted text so a `replace` that
 * contains `find` cannot loop forever. A `find` that is absent (or equal to `replace`, or empty)
 * is skipped — making the operation a safe no-op when the live text has already diverged.
 *
 * @param ytext - The Y.Text to mutate.
 * @param replacements - The deltas to apply.
 * @returns The number of individual occurrences replaced.
 */
export function applyReplacementsToYText(
  ytext: Y.Text,
  replacements: ReadonlyArray<ContentReplacement>,
): number {
  let applied = 0;
  for (const { find, replace } of replacements) {
    if (find.length === 0 || find === replace) continue;
    let searchFrom = 0;
    for (;;) {
      const current = ytext.toString();
      const index = current.indexOf(find, searchFrom);
      if (index === -1) break;
      ytext.delete(index, find.length);
      ytext.insert(index, replace);
      applied += 1;
      searchFrom = index + replace.length;
    }
  }
  return applied;
}

/**
 * Applies reference rewrites to the live collaborative document identified by the request, via a
 * server-side direct connection. `openDirectConnection` attaches to a room that is already open
 * (so connected editors see the change immediately) or loads a dormant one from its authoritative
 * Yjs state — never from the possibly-stale plain-text file. The edit is applied in a transaction;
 * `disconnect()` forces the normal writeback (persisting the corrected Yjs state AND plain text)
 * and unloads the room if no one else is connected.
 *
 * @param hocuspocus - The Hocuspocus instance owning the live documents.
 * @param request - The document identity and the replacements to apply.
 * @returns The number of occurrences replaced.
 */
export async function applyEditsToDocument(
  hocuspocus: Pick<Hocuspocus, 'openDirectConnection'>,
  request: ApplyEditsRequest,
): Promise<number> {
  const roomName = `${request.projectId}/${request.yjsStateId}`;
  const connection = await hocuspocus.openDirectConnection(roomName);
  let applied = 0;
  try {
    await connection.transact((document) => {
      applied = applyReplacementsToYText(document.getText(CODEMIRROR_TEXT), request.replacements);
    });
  } finally {
    await connection.disconnect();
  }
  return applied;
}

/**
 * Reconciles a Y.Text toward `target` with the minimal single-region splice: the common PREFIX and
 * (non-overlapping) common SUFFIX of `current` and `target` are left untouched, and only the
 * changed middle is deleted/inserted. This is at most one `delete` and one `insert` (or neither,
 * when `current === target`) rather than a full clear+rewrite — which preserves CRDT positions
 * (and any concurrent cursors) outside the changed region. MUST be called inside a Yjs transaction.
 *
 * @param ytext - The Y.Text to reconcile in place.
 * @param target - The content the text should end up containing.
 */
export function replaceTextMinimalDiff(ytext: Y.Text, target: string): void {
  const current = ytext.toString();
  if (current === target) return;

  const maxPrefix = Math.min(current.length, target.length);
  let prefix = 0;
  while (prefix < maxPrefix && current[prefix] === target[prefix]) prefix += 1;

  // Compare the tails of the two REMAINDERS (current.slice(prefix) vs target.slice(prefix)), so the
  // match can never reach back into the already-matched prefix on either side — that is the clamp.
  const maxSuffix = Math.min(current.length - prefix, target.length - prefix);
  let suffix = 0;
  while (suffix < maxSuffix && current[current.length - 1 - suffix] === target[target.length - 1 - suffix]) {
    suffix += 1;
  }

  const deleteCount = current.length - prefix - suffix;
  if (deleteCount > 0) ytext.delete(prefix, deleteCount);

  const insertText = target.slice(prefix, target.length - suffix);
  if (insertText.length > 0) ytext.insert(prefix, insertText);
}

/**
 * Replaces the entire content of the live collaborative document identified by the request with
 * `request.content`, via a server-side direct connection — the server side of a "pull remote
 * changes" landing. Mirrors {@link applyEditsToDocument}'s lifecycle exactly: `openDirectConnection`
 * attaches to an already-open room or loads a dormant one from its authoritative Yjs state; the
 * reconciliation runs inside a single transaction via {@link replaceTextMinimalDiff}; `disconnect()`
 * forces the normal writeback (Yjs state + plain text) and unloads the room if idle.
 *
 * @param hocuspocus - The Hocuspocus instance owning the live documents.
 * @param request - The document identity and the target content.
 */
export async function replaceDocumentContent(
  hocuspocus: Pick<Hocuspocus, 'openDirectConnection'>,
  request: ApplyFullContentRequest,
): Promise<void> {
  const roomName = `${request.projectId}/${request.yjsStateId}`;
  const connection = await hocuspocus.openDirectConnection(roomName);
  try {
    await connection.transact((document) => {
      replaceTextMinimalDiff(document.getText(CODEMIRROR_TEXT), request.content);
    });
  } finally {
    await connection.disconnect();
  }
}

/** A request to apply a selection- and regex-aware replacement to one collaborative document. */
export interface StructuredApplyRequest {
  /** Project that owns the document. */
  projectId: string;
  /** Yjs state identifier — identifies the document's collaboration room. */
  yjsStateId: string;
  /** The query, re-evaluated against the live content inside the transaction. */
  query: SearchQuery;
  /** Literal replacement text, or a capture-group template in regex mode. */
  replacement: string;
  /** The confirmed `{ordinal, expectedText}` selections for this document. */
  selections: ReplaceSelection[];
}

/**
 * Applies a structured (selection- and regex-aware) replacement to the live collaborative document.
 *
 * Unlike {@link applyEditsToDocument} (occurrence-global literal), this re-runs the query against
 * the CURRENT live `Y.Text` **inside the direct-connection transaction**, computes exact match
 * spans, and rewrites only the confirmed selections — right-to-left so offsets stay valid. A span
 * whose live text no longer equals its `expectedText` is skipped (stale), so the operation merges
 * cleanly with concurrent edits and never over-writes. Re-matching late (rather than trusting
 * scan-time offsets) is what makes positional editing safe here. `disconnect()` forces the normal
 * writeback (Yjs blob + plain text) and unloads the room if idle.
 *
 * @param hocuspocus - The Hocuspocus instance owning the live documents.
 * @param engine - The RE2 engine used to re-match a regex query (same adapter as the API scan).
 * @param request - The document identity, query, replacement, and confirmed selections.
 * @returns The number of occurrences actually replaced (0 when the live content diverged from every
 *   selection — the caller must NOT then force a plain-text write).
 */
export async function applyStructuredReplacementToDocument(
  hocuspocus: Pick<Hocuspocus, 'openDirectConnection'>,
  engine: RegexEngine,
  request: StructuredApplyRequest,
): Promise<number> {
  const roomName = `${request.projectId}/${request.yjsStateId}`;
  const connection = await hocuspocus.openDirectConnection(roomName);
  let applied = 0;
  try {
    await connection.transact((document) => {
      const ytext = document.getText(CODEMIRROR_TEXT);
      const content = ytext.toString();
      const budget: MatchBudget = {
        maxMatches: STRUCTURED_APPLY_MAX_MATCHES,
        deadline: Date.now() + STRUCTURED_APPLY_BUDGET_MS,
      };
      const matched = computeMatches(content, request.query, engine, budget);
      if (!matched.success) return; // invalid pattern (already rejected upstream) → no-op
      const edits = selectSpans(matched.value, request.selections, request.replacement, request.query.mode);
      // Edits are right-to-left, so applying each one leaves earlier offsets valid.
      for (const edit of edits) {
        ytext.delete(edit.from, edit.to - edit.from);
        ytext.insert(edit.from, edit.replacement);
        applied += 1;
      }
    });
  } finally {
    await connection.disconnect();
  }
  return applied;
}

/**
 * Reads the live text of the collaborative document identified by the request WITHOUT loading a
 * room or triggering a writeback — a pure read.
 *
 * - If the room is currently loaded in memory (someone is editing it), its in-memory `Y.Doc` is the
 *   freshest source of truth and is read directly.
 * - Otherwise the persisted Yjs state is decoded in a throwaway `Y.Doc`. This is the same
 *   authoritative state `openDirectConnection` would have loaded, but without opening the room (and
 *   so without the store-on-disconnect writeback that a dormant-room open + disconnect would force).
 *
 * Unlike the plain-text file store, both paths reflect edits that have not yet been written back.
 * Returns null when there is NO live source — a dormant room with no persisted Yjs state yet (such
 * as a document that has a record but was never actually opened/edited). That is not an error: the
 * caller falls back to the authoritative file store for such files.
 *
 * @param hocuspocus - The Hocuspocus instance owning the live documents (its `documents` map).
 * @param yjsStateStore - Store used to load the persisted Yjs state for a dormant room.
 * @param request - The document identity to read.
 * @returns The current document text, or null when no live source exists for it.
 */
export async function readDocumentContent(
  hocuspocus: Pick<Hocuspocus, 'documents'>,
  yjsStateStore: YjsStateStore,
  request: ReadContentRequest,
): Promise<string | null> {
  const roomName = `${request.projectId}/${request.yjsStateId}`;

  const loaded = hocuspocus.documents.get(roomName);
  if (loaded) return loaded.getText(CODEMIRROR_TEXT).toString();

  const state = await yjsStateStore.load(ProjectId.create(request.projectId), YjsStateId.create(request.yjsStateId));
  if (!state) return null;
  const document = new Y.Doc();
  try {
    Y.applyUpdate(document, state);
    return document.getText(CODEMIRROR_TEXT).toString();
  } finally {
    document.destroy();
  }
}
