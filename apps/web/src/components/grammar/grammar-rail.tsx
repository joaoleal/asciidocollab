'use client';

import { useSyncExternalStore } from 'react';
import { cn } from '@/lib/utilities';
import {
  getDocumentScopeSnapshot,
  subscribeDocumentScope,
  type DocumentScopeSnapshot,
} from '@/lib/codemirror/harper/document-scope-store';
import type { IncludedFileIssue } from '@/lib/codemirror/harper/included-file-lint';
import { groupByCategory, categoryCounts, type PositionedGrammarDiagnostic } from '@/lib/codemirror/harper/grammar-diagnostics';
import { GRAMMAR_CATEGORIES, GRAMMAR_CATEGORY_DOT_CLASS, type GrammarCategory } from '@/lib/codemirror/harper/category-colors';
import type { EngineSuggestion } from '@/lib/codemirror/harper/harper-engine';
import type { GrammarEngineStatus } from '@/lib/codemirror/harper/harper-worker-client';
import { SuggestionPopover } from '@/components/grammar/suggestion-popover';
import { RuleChip } from '@/components/grammar/rule-chip';

/** The engine's rule explanations, keyed by rule name; empty until they have loaded. */
export type RuleDescriptions = Readonly<Record<string, string>>;

/** Human-readable category headings. */
const CATEGORY_LABELS: Readonly<Record<GrammarCategory, string>> = {
  spelling: 'Spelling',
  grammar: 'Grammar',
  style: 'Style',
};

/** The short header indicator label for each engine status. */
const STATUS_INDICATOR: Readonly<Record<GrammarEngineStatus, string>> = {
  ready: 'On-device',
  loading: 'Loading…',
  failed: 'Unavailable',
  disabled: 'Off',
};

/** The empty-state body copy for each engine status (shown when there are no issues to list). */
const STATUS_EMPTY_COPY: Readonly<Record<GrammarEngineStatus, string>> = {
  ready: 'No writing issues found.',
  loading: 'Starting the checker…',
  failed: 'The writing checker could not start. Reopen the file to try again.',
  disabled: 'Writing checks are off for this project (they run on English-language projects).',
};

/** Pluralise "file" for the cross-file copy. */
function fileWord(count: number): string {
  return count === 1 ? 'file' : 'files';
}

/**
 * The line to show in place of a cross-file issue list: the pass is still running, or it found nothing,
 * or there is no larger document for "Whole document" to mean. Returns null when there are issues to
 * list instead.
 */
function documentScopeNotice(scope: DocumentScopeSnapshot): string | null {
  if (scope.state === 'scanning') {
    return `Checking ${scope.fileCount} other ${fileWord(scope.fileCount)}…`;
  }
  if (scope.state === 'alone') {
    return 'This file includes no other files, so it is the whole document.';
  }
  if (scope.state === 'outside-main') {
    return 'This file is not part of the main document, so there is nothing else to check.';
  }
  if (scope.state === 'checked' && scope.issues.length === 0) {
    return `No writing issues in the other ${scope.fileCount} ${fileWord(scope.fileCount)}.`;
  }
  if (scope.state === 'incomplete' && scope.issues.length === 0) {
    return `Could not finish checking the other ${scope.fileCount} ${fileWord(scope.fileCount)} — editing interrupts the pass. Switch the scope off and on to try again.`;
  }
  return null;
}

/**
 * The issues "Whole document" scope adds: the ones found in the files this document pulls in with
 * `include::`. They are listed with their file and line rather than underlined, because they have no
 * position in the editor's document — and for the same reason they carry no fix chips: applying a fix
 * here would edit the open file at an offset that means nothing. Selecting one opens its file instead.
 *
 * @param properties - The current cross-file snapshot.
 * @returns The section element, or null while the panel is scoped to this file.
 */
function OtherFilesSection({
  scope,
  ruleDescriptions,
}: {
  scope: DocumentScopeSnapshot;
  ruleDescriptions: RuleDescriptions;
}): React.JSX.Element | null {
  if (scope.state === 'inactive') return null;
  const notice = documentScopeNotice(scope);
  return (
    <section aria-label="Other files">
      <h3 className="mb-1 flex items-center gap-2 px-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        In other files
        <span className="ml-auto tabular-nums">{scope.issues.length}</span>
      </h3>
      {notice === null ? (
        <ul className="flex flex-col gap-1">
          {scope.issues.map((issue: IncludedFileIssue, index: number) => (
            /* The rule chip sits outside the row button for the same reason it does in the issue cards
               (see suggestion-popover): nested, the rule name would join the button's accessible name,
               which describes opening the issue's file, not the rule. It also goes BELOW the button, not
               beside it: a long rule name cannot shrink, so on the same row it took a third of a narrow
               panel and wrapped the message every few words. */
            <li key={`${issue.path}:${issue.line}:${index}`} className="flex flex-col">
              <button
                type="button"
                className="rounded px-2 py-1 text-left hover:bg-accent"
                onClick={() => scope.reveal?.(issue)}
              >
                <span
                  className={cn('mr-2 inline-block h-2 w-2 rounded-full align-middle', GRAMMAR_CATEGORY_DOT_CLASS[issue.category])}
                  aria-hidden="true"
                />
                {issue.message}
                <span className="block text-[11px] text-muted-foreground">{`${issue.path}:${issue.line}`}</span>
              </button>
              <RuleChip
                rule={issue.rule}
                className="ml-auto mr-2"
                {...(ruleDescriptions[issue.rule] ? { description: ruleDescriptions[issue.rule] } : {})}
              />
            </li>
          ))}
        </ul>
      ) : (
        <p className="px-2 pb-1 text-muted-foreground">{notice}</p>
      )}
      {scope.state === 'incomplete' && scope.issues.length > 0 && (
        <p className="px-2 pb-1 text-[11px] text-muted-foreground">
          This list may be incomplete — the pass did not finish.
        </p>
      )}
    </section>
  );
}

/** Props for {@link GrammarRail}. */
export interface GrammarRailProperties {
  /** The current grammar issues with live document positions. */
  diagnostics: PositionedGrammarDiagnostic[];
  /** The on-device engine status (drives the header indicator + empty-state copy). */
  status: GrammarEngineStatus;
  /**
   * Navigate the editor to an issue.
   *
   * @param from - Document offset of the issue start.
   * @param to - Document offset just past the issue.
   */
  onNavigate: (from: number, to: number) => void;
  /**
   * Apply a suggested fix to an issue.
   *
   * @param entry - The issue being resolved.
   * @param suggestion - The chosen suggestion.
   */
  onApply: (entry: PositionedGrammarDiagnostic, suggestion: EngineSuggestion) => void;
  /**
   * Dismiss an issue for this reader, or null when the dismissal has nowhere to be stored — in which
   * case no Ignore control is shown, rather than one that quietly forgets.
   *
   * @param entry - The issue to stop reporting.
   */
  onIgnore?: ((entry: PositionedGrammarDiagnostic) => void) | null;
  /**
   * Accept the word a spelling issue flagged into the project dictionary. Null when the reader may not
   * manage the dictionary (viewers), so the control is absent instead of failing on click.
   *
   * @param entry - The issue whose flagged word to accept.
   */
  onAddToDictionary?: ((entry: PositionedGrammarDiagnostic) => void) | null;
  /**
   * The engine's explanation of each rule, keyed by rule name, used as the rule chips' hover text.
   * Optional and defaulted to empty: the descriptions load asynchronously with the engine, and an
   * issue names its rule whether or not they have arrived.
   */
  ruleDescriptions?: RuleDescriptions;
  /**
   * When true the reader may not edit the open document, so every fix chip renders disabled with the
   * reason on hover and {@link GrammarRailProperties.onApply} is never called. Issues, their messages
   * and their proposed corrections stay fully visible — reading a document includes reading what is
   * wrong with it.
   */
  readOnly?: boolean;
  /** Extra class names for the container. */
  className?: string;
}

/**
 * The right-hand Grammar panel's Issues tab: every current issue grouped by category, each showing its
 * message and one-click fix chips, with selection navigating the editor to the issue. Resolving an
 * issue (applying a fix) removes it from the list because the underlying document edit clears the
 * diagnostic on the next lint pass — the rail always reflects the live diagnostic set.
 *
 * Under "Whole document" scope it also lists the issues found in the other files of the document's
 * `include::` tree, in their own section below (see {@link OtherFilesSection}).
 *
 * @param properties - The diagnostics and interaction callbacks.
 * @returns The panel element.
 */
export function GrammarRail({
  diagnostics,
  status,
  onNavigate,
  onApply,
  onIgnore,
  onAddToDictionary,
  ruleDescriptions = {},
  readOnly = false,
  className,
}: GrammarRailProperties): React.JSX.Element {
  const groups = groupByCategory(diagnostics);
  const counts = categoryCounts(diagnostics);
  const isReady = status === 'ready';
  // The cross-file half of "Whole document" scope, published by the editor mount. Kept separate from
  // `diagnostics` (which are live document positions) because these issues are in other files.
  const documentScope = useSyncExternalStore(
    subscribeDocumentScope,
    getDocumentScopeSnapshot,
    getDocumentScopeSnapshot,
  );
  const hasOtherFileIssues = documentScope.issues.length > 0;

  return (
    <div className={cn('flex h-full flex-col gap-2 overflow-y-auto p-2 text-xs', className)} aria-label="Grammar issues">
      {/* Engine status only — the view's title is the panel header's job (the Writing view owns it),
          so this list never repeats it. */}
      <header className="flex items-center justify-end">
        <span
          className={cn('text-[11px]', isReady ? 'text-[hsl(var(--success))]' : 'text-muted-foreground')}
          title={STATUS_EMPTY_COPY[status]}
        >
          {STATUS_INDICATOR[status]}
        </span>
      </header>

      {counts.total === 0 && !hasOtherFileIssues && (
        <p className="px-2 py-2 text-muted-foreground">{STATUS_EMPTY_COPY[status]}</p>
      )}
      {counts.total === 0 && hasOtherFileIssues && (
        <p className="px-2 py-2 text-muted-foreground">No writing issues in this file.</p>
      )}
      {counts.total > 0 && (
        GRAMMAR_CATEGORIES.filter((category) => groups.has(category)).map((category) => {
          const entries = groups.get(category) ?? [];
          return (
            <section key={category} aria-label={CATEGORY_LABELS[category]}>
              <h3 className="mb-1 flex items-center gap-2 px-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                <span className={cn('inline-block h-2 w-2 rounded-full', GRAMMAR_CATEGORY_DOT_CLASS[category])} aria-hidden="true" />
                {CATEGORY_LABELS[category]}
                <span className="ml-auto tabular-nums">{entries.length}</span>
              </h3>
              {/* Each issue is its own card, styled like a review comment thread (see thread-card):
                  the two right-hand panels are siblings, so they should read as siblings. It also solves
                  the real complaint about the previous flat list — with only a 4px gap between rows, a
                  two-line message ran visually into the next issue. A border and a hover affordance make
                  each issue a discrete, obviously-clickable object. */}
              <ul className="flex flex-col gap-1.5">
                {entries.map((entry) => (
                  <li
                    key={`${entry.from}:${entry.to}:${entry.diagnostic.message}`}
                    data-testid="grammar-issue-card"
                    className="rounded-lg border bg-card text-card-foreground shadow-sm transition-colors hover:border-primary hover:bg-primary/5"
                  >
                    {/* One definition of "an issue and what you can do about it", shared with the
                        editor's own tooltip, so the panel and the tooltip cannot drift apart. Accepting
                        a word is offered for spelling issues only — a grammar or style lint has no word
                        to accept into the dictionary. */}
                    <SuggestionPopover
                      className="gap-1 p-1.5 text-xs"
                      diagnostic={entry.diagnostic}
                      {...(ruleDescriptions[entry.diagnostic.grammarLint.rule]
                        ? { ruleDescription: ruleDescriptions[entry.diagnostic.grammarLint.rule] }
                        : {})}
                      onSelect={() => onNavigate(entry.from, entry.to)}
                      readOnly={readOnly}
                      onApply={(suggestion) => {
                        // Belt to the popover's braces: the chips are already disabled, but this
                        // component — not the popover — is the one told whether the reader may edit.
                        if (readOnly) return;
                        onApply(entry, suggestion);
                      }}
                      {...(onIgnore ? { onIgnore: () => onIgnore(entry) } : {})}
                      {...(onAddToDictionary && category === 'spelling'
                        ? { onAddToDictionary: () => onAddToDictionary(entry) }
                        : {})}
                    />
                  </li>
                ))}
              </ul>
            </section>
          );
        })
      )}

      <OtherFilesSection scope={documentScope} ruleDescriptions={ruleDescriptions} />
    </div>
  );
}
