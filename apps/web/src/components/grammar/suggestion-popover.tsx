'use client';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utilities';
import { suggestionLabel } from '@/lib/codemirror/harper/apply-suggestion';
import { GRAMMAR_CATEGORY_DOT_CLASS } from '@/lib/codemirror/harper/category-colors';
import { RuleChip } from '@/components/grammar/rule-chip';
import { lintRuleLabel } from '@/lib/codemirror/harper/lint-rule-label';
import type { GrammarDiagnostic } from '@/lib/codemirror/harper/lint-to-diagnostic';
import type { EngineSuggestion } from '@/lib/codemirror/harper/harper-engine';

/** Props for the inline grammar suggestion popover. */
export interface SuggestionPopoverProperties {
  /** The diagnostic whose message + suggested fixes are shown. */
  diagnostic: GrammarDiagnostic;
  /**
   * The engine's explanation of the rule that fired, shown when hovering the rule chip. Omitted until
   * the rule descriptions have loaded (or when this rule has none), in which case the chip still names
   * the rule and simply has nothing extra to say.
   */
  ruleDescription?: string;
  /**
   * Apply a suggested fix.
   *
   * @param suggestion - The chosen suggestion.
   */
  onApply: (suggestion: EngineSuggestion) => void;
  /** Add the flagged word to the project dictionary, when the action is available (spelling issues). */
  onAddToDictionary?: () => void;
  /** Ignore this issue for the current user, when the action is available. */
  onIgnore?: () => void;
  /**
   * Select this issue, which navigates the editor to it. Given by the panel, where the issue is listed
   * away from the text; omitted in the editor's own tooltip, which is already anchored to it — there,
   * making the message a control would be a button that goes where you already are.
   */
  onSelect?: () => void;
  /**
   * When true the reader may not edit the document, so the fix chips render disabled with the reason
   * on hover instead of vanishing (viewer/observer mode). They stay visible because seeing the
   * correction the checker proposes is reading, not writing; only accepting it is a change.
   */
  readOnly?: boolean;
  /** Extra class names for the container. */
  className?: string;
}

/**
 * The inline popover surfaced for a grammar/spelling/style issue: its message, category, and a chip per
 * suggested fix, plus optional "add to dictionary" and "ignore" actions. Purely presentational — the
 * caller owns applying the fix (an ordinary document change) and the dictionary/ignore side effects —
 * so it renders identically in the editor tooltip and the review panel.
 *
 * Permission is expressed two ways, matching the review components: an action the reader may not take
 * at all is simply not passed (`onAddToDictionary` is omitted for a reader who cannot manage the
 * dictionary), while the fix chips — which double as the display of the proposed correction — are
 * rendered disabled with the reason on hover when {@link SuggestionPopoverProperties.readOnly} is set.
 *
 * @param properties - The diagnostic and the action callbacks.
 * @returns The popover element.
 */
export function SuggestionPopover({
  diagnostic,
  ruleDescription,
  onApply,
  onAddToDictionary,
  onIgnore,
  onSelect,
  readOnly = false,
  className,
}: SuggestionPopoverProperties): React.JSX.Element {
  const dot = (
    <span
      className={cn('inline-block h-2 w-2 shrink-0 rounded-full', GRAMMAR_CATEGORY_DOT_CLASS[diagnostic.category])}
      aria-hidden="true"
    />
  );
  // The rule name is metadata, so it goes in the card's footer rather than on the message's line. Beside
  // the message it starved it: a name like `SentenceCapitalization` has a wide min-content width and must
  // not shrink (an elided `Sentence…` is not discoverable), so in a narrow panel the row handed it a
  // third of the card and wrapped the message every few words. In the footer the message gets the full
  // measure, and the chip — trailing, right-aligned, small and muted — costs no extra height because the
  // actions already occupy that line. The name is read off the lint the engine produced, which is the
  // same object identity `ignore` is matched against, so the chip cannot name a rule from another issue.
  const ruleLabel = lintRuleLabel(diagnostic.grammarLint.rule);
  const hasActions = diagnostic.grammarSuggestions.length > 0 || Boolean(onAddToDictionary) || Boolean(onIgnore);
  return (
    <div className={cn('flex flex-col gap-1 p-2 text-sm', className)} role="group" aria-label="Writing suggestion">
      {/* The message owns its own full-width row, and the rule chip below is OUTSIDE this control, never
          a child of it: nested, its text joined the accessible name ("…may be misspelled SpellCheck"),
          which misreports what activating the button does. */}
      {onSelect ? (
        <button
          type="button"
          className="flex items-start gap-2 rounded px-2 py-1 text-left hover:bg-accent"
          onClick={onSelect}
        >
          <span className="mt-1">{dot}</span>
          <span className="min-w-0 flex-1">{diagnostic.message}</span>
        </button>
      ) : (
        <p className="flex items-start gap-2">
          <span className="mt-1">{dot}</span>
          <span className="min-w-0 flex-1">{diagnostic.message}</span>
        </p>
      )}
      {(hasActions || ruleLabel !== null) && (
        <div className="flex flex-wrap items-center gap-1 px-2" data-testid="grammar-issue-actions">
          {/* Dismissing and accepting sit with the fixes because they resolve the same issue by other
              means: a fix changes the text, "Add to dictionary" says the word is right, and "Ignore"
              says this instance is fine. */}
          {diagnostic.grammarSuggestions.map((suggestion, index) => (
            <Button
              key={`${suggestion.kind}:${suggestion.text}:${index}`}
              type="button"
              size="sm"
              variant="secondary"
              className="h-6 px-2 text-xs"
              // Disabled rather than hidden for a reader who may not edit, so the proposed correction
              // is still legible; the click path is guarded too, because `disabled` is a rendering
              // decision and this component is not where the document is owned.
              disabled={readOnly}
              {...(readOnly ? { title: 'You do not have permission to edit this file.' } : {})}
              onClick={() => {
                if (readOnly) return;
                onApply(suggestion);
              }}
            >
              {suggestionLabel(suggestion)}
            </Button>
          ))}
          {onAddToDictionary && (
            <Button type="button" size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={onAddToDictionary}>
              Add to dictionary
            </Button>
          )}
          {onIgnore && (
            <Button type="button" size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={onIgnore}>
              Ignore
            </Button>
          )}
          {/* Pushed to the far end of the row, so the actions stay on the reading path and the rule sits
              out of it. It wraps onto a line of its own when the actions leave it no room. */}
          <RuleChip
            rule={diagnostic.grammarLint.rule}
            className="ml-auto"
            {...(ruleDescription ? { description: ruleDescription } : {})}
          />
        </div>
      )}
    </div>
  );
}
