/**
 * Decides what to show for the Harper rule behind a writing issue.
 *
 * The rule name is shown VERBATIM — `Albeit`, `SpelledNumbers`, `SpellCheck` — even though it is a
 * PascalCase identifier. It is deliberately not split into words or sentence-cased: these are the exact
 * keys of the engine's rule configuration, so they are also the exact strings listed in the Writing
 * panel's Rules tab and matched by its search box. "Spelled numbers" would read a little better and
 * would no longer be findable, which is the whole point of naming the rule.
 *
 * An earlier version of this module labelled `Lint.lint_kind()` instead (`WordChoice` → `Word choice`).
 * That was dropped because the kind only repeats the section the issue is already listed under
 * (Spelling / Grammar / Style), telling the reader nothing new.
 */

/**
 * The label to show for a lint's rule.
 *
 * @param rule - The engine-reported rule name (`EngineLint.rule`).
 * @returns The rule name to render, or null when there is no rule to name — the caller then renders
 *   nothing, because a chip reading "" or "Unknown" claims an identity the engine never gave.
 */
export function lintRuleLabel(rule: string): string | null {
  const trimmed = rule.trim();
  return trimmed === '' ? null : trimmed;
}
