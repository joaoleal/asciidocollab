'use client';

import { cn } from '@/lib/utilities';
import { lintRuleLabel } from '@/lib/codemirror/harper/lint-rule-label';

/** Props for {@link RuleChip}. */
export interface RuleChipProperties {
  /** The engine-reported rule name, e.g. `Albeit`. Empty or whitespace renders nothing. */
  rule: string;
  /**
   * The engine's one-line explanation of the rule, when it has been loaded. Shown on hover, because a
   * bare identifier says which rule fired but not what it checks.
   */
  description?: string;
  /** Extra class names, so the caller can align the chip within its own row. */
  className?: string;
}

/**
 * The small chip naming the Harper rule behind a writing issue.
 *
 * Shared by the panel's issue cards and its cross-file list so both name rules the same way, and so
 * there is one place holding the reason the raw identifier is shown (see {@link lintRuleLabel}).
 *
 * It must always be rendered OUTSIDE the issue's control, never inside it: nested, the rule name joins
 * the button's accessible name ("…may be misspelled SpellCheck"), which misreports what activating the
 * button does.
 *
 * @param properties - The rule name and its optional description.
 * @returns The chip, or null when there is no rule to name.
 */
export function RuleChip({ rule, description, className }: RuleChipProperties): React.JSX.Element | null {
  const label = lintRuleLabel(rule);
  if (!label) return null;
  return (
    <span
      className={cn(
        // `shrink-0` + `max-w-full` + `truncate`: the chip never shrinks below its name (a name elided to
        // `Sentence…` is not discoverable), so in a wrapping row it moves to its own line instead of
        // squeezing its neighbours — which is why callers must not put it on the message's own line. It
        // is elided only when the name alone is wider than the panel, and the full name is in the title.
        'max-w-full shrink-0 truncate rounded-sm bg-muted px-1 py-px font-mono text-[10px] font-medium leading-tight text-muted-foreground',
        className,
      )}
      // "Rule:" keeps the identifier from reading as a stray word, and the description explains it when
      // the engine's rule descriptions have loaded.
      title={description ? `Rule: ${label} — ${description}` : `Rule: ${label}`}
      data-testid="grammar-issue-rule"
    >
      {label}
    </span>
  );
}
