import { syntaxTree } from '@codemirror/language';
import type { EditorView } from '@codemirror/view';
import type { Diagnostic } from '@codemirror/lint';
import { extractProseSegments, type ProseSegment } from '../prose-segments';
import { lintToDiagnostic, type GrammarDiagnostic } from './lint-to-diagnostic';
import type { HarperWorkerClient, SegmentLints } from './harper-worker-client';

/**
 * The `@codemirror/lint` source backed by the Harper worker client. It walks the document's prose
 * segments, lints them off the main thread, and maps each lint back to a category-tagged document
 * diagnostic. It NEVER dispatches a document change — that is the invariant keeping grammar feedback
 * out of the shared Yjs document (Principle VII); the only shared write is the explicit apply action.
 *
 * When the engine is unavailable (WASM failed to load) or the request was superseded, it resolves to
 * an empty array rather than throwing, so the editor stays fully usable and the nspell fallback shows
 * instead (graceful degradation, Principle X).
 */

/**
 * How much of the writing the checker reports on.
 *
 * - `this-file` — every prose segment of the file open in the editor. This is what the editor itself
 *   can underline, because the CodeMirror document IS the open file.
 * - `whole-document` — the open file PLUS the other files of its `include::` tree. The extra files have
 *   no position in this editor, so they are checked by a separate pass
 *   (`included-file-lint.ts`) and listed, not underlined.
 *
 * Both scopes therefore produce the same editor underlines; the scope widens what the Writing panel
 * lists. It is a per-view preference and never changes what other collaborators check.
 */
export type LintScope = 'this-file' | 'whole-document';

/**
 * Dependencies the Harper lint source reads on each run.
 *
 * The dialect and the hydration state are deliberately absent: both live on the client (a dialect
 * change goes through `setDialect`, hydration through `importWords`/`importIgnoredLints`, each
 * invalidating its cache), so a getter here would be a second, stale copy of the same fact.
 */
export interface HarperLintSourceDeps {
  /** The worker client that lints off the main thread. */
  client: HarperWorkerClient;
  /**
   * Dismiss this issue for this user and persist the dismissal. Omitted when the host has nowhere to
   * store it (no document id), in which case no Ignore action is offered rather than one that
   * silently forgets.
   *
   * @param diagnostic - The issue the reader chose to dismiss.
   */
  onIgnore?: (diagnostic: GrammarDiagnostic) => void;
}

/**
 * Pair each segment's lints (returned by the client) with the segment that produced them and map every
 * lint to an absolute-position diagnostic. Pure, so it unit-tests without an editor: segment ids are
 * their index in `segments`.
 *
 * @param segments - The prose segments that were linted, in order.
 * @param results - The per-segment lints from the worker client, keyed by the segment's index id.
 * @returns The flattened diagnostics in document order.
 */
export function buildGrammarDiagnostics(
  segments: ProseSegment[],
  results: SegmentLints[],
): GrammarDiagnostic[] {
  const diagnostics: GrammarDiagnostic[] = [];
  for (const result of results) {
    const segment = segments[Number(result.id)];
    if (!segment) continue; // a stale/unknown id (the document changed) — skip rather than mis-map
    for (const lint of result.lints) {
      diagnostics.push(lintToDiagnostic(lint, segment));
    }
  }
  return diagnostics;
}

/**
 * Build the async `@codemirror/lint` source function for Harper.
 *
 * Every prose segment of the open file is checked, whatever the panel's scope: the editor can only
 * underline text that has a position in ITS document, and that document is the open file in both
 * scopes. Narrowing by selection was tried and removed — an underline that appears and disappears as
 * the caret moves reads as the checker losing track rather than as a setting.
 *
 * @param deps - The worker client, and the dismiss handler when dismissals can be stored.
 * @returns An async lint source producing category-tagged diagnostics, or an empty array on degradation.
 */
export function harperLintSource(
  deps: HarperLintSourceDeps,
): (view: EditorView) => Promise<Diagnostic[]> {
  return async (view: EditorView): Promise<Diagnostic[]> => {
    const tree = syntaxTree(view.state);
    const text = view.state.doc.toString();
    const segments = extractProseSegments(tree, text);
    if (segments.length === 0) return [];

    // The lint id is the segment's index into the list; buildGrammarDiagnostics maps results back by
    // that same index, so positions stay correct.
    const results = await deps.client.lint(segments.map((segment, index) => ({ id: String(index), text: segment.text })));
    if (!results) return []; // superseded or engine unavailable — show nothing, stay usable
    const diagnostics = buildGrammarDiagnostics(segments, results);
    const onIgnore = deps.onIgnore;
    if (!onIgnore) return diagnostics;
    // "Ignore" belongs on the tooltip beside the fixes, and it is attached HERE rather than in the pure
    // mapper because dismissing a lint needs the client that produced it.
    return diagnostics.map((diagnostic) => ({
      ...diagnostic,
      actions: [
        ...(diagnostic.actions ?? []),
        {
          name: 'Ignore',
          apply: () => onIgnore(diagnostic),
        },
      ],
    }));
  };
}
