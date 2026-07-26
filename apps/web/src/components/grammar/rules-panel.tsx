'use client';

import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utilities';

/** A rule's effective state: explicitly on, explicitly off, or left at the engine default (`null`). */
export type RuleState = boolean | null;

/** Props for {@link RulesPanel}. */
export interface RulesPanelProperties {
  /**
   * The current rule configuration, keyed by engine-reported rule name. Rendered as-is — the rule set
   * is engine-defined and must never be hardcoded (research R9); an empty object shows an empty state.
   */
  config: Record<string, RuleState>;
  /**
   * Toggle a single rule between on and off.
   *
   * @param rule - The rule name.
   * @param enabled - The new enabled state.
   */
  onToggle: (rule: string, enabled: boolean) => void;
  /** Reset every rule to the engine default. */
  onResetDefaults: () => void;
  /**
   * When true, the rule list is read-only: every toggle and Reset is disabled and the handlers are
   * not called. The rules stay listed — a reader may still see which checks are running.
   */
  readOnly?: boolean;
  /** Extra class names. */
  className?: string;
}

/**
 * The Grammar panel's Rules tab: a searchable, data-driven list of the engine's rules, each toggleable
 * on/off, plus a reset-to-defaults action (spec FR-027). The configuration is view-local — it changes
 * only what this collaborator sees, never what others check — so {@link RulesPanelProperties.readOnly}
 * is not a write-authorization boundary; it keeps this tab consistent with the rest of the Writing
 * surface, which offers a reader no controls that change how the document is checked. Searching and
 * reading the list stay available either way.
 *
 * @param properties - The rule config and change handlers.
 * @returns The panel element.
 */
export function RulesPanel({ config, onToggle, onResetDefaults, readOnly = false, className }: RulesPanelProperties): React.JSX.Element {
  const [query, setQuery] = useState('');
  const rules = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return Object.keys(config)
      .filter((rule) => (needle ? rule.toLowerCase().includes(needle) : true))
      .toSorted((a, b) => a.localeCompare(b));
  }, [config, query]);

  return (
    <div className={cn('flex h-full flex-col gap-2 p-2 text-xs', className)} aria-label="Grammar rules">
      <div className="flex items-center gap-1">
        <Input
          type="search"
          placeholder="Search rules…"
          aria-label="Search rules"
          className="h-7 px-2"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-7 px-2 text-xs"
          disabled={readOnly}
          title={readOnly ? 'You do not have permission to change rules' : undefined}
          onClick={() => {
            if (readOnly) return;
            onResetDefaults();
          }}
        >
          Reset
        </Button>
      </div>
      {rules.length === 0 ? (
        <p className="px-2 py-2 text-muted-foreground">
          {Object.keys(config).length === 0 ? 'Rules load with the checker.' : 'No matching rules.'}
        </p>
      ) : (
        <ul className="flex flex-col gap-0.5 overflow-y-auto">
          {rules.map((rule) => (
            <li key={rule} className="flex items-center gap-2 rounded px-2 py-1 hover:bg-accent">
              <label
                className={cn('flex flex-1 items-center gap-2', readOnly && 'cursor-not-allowed opacity-60')}
                {...(readOnly ? { title: 'You do not have permission to change rules' } : {})}
              >
                <input
                  type="checkbox"
                  // A rule the user has never touched is `null` — "whatever the engine decides" — which
                  // is neither on nor off. Rendering it ticked claims we know Harper enables it, and for
                  // the ones Harper disables by default that claim is wrong: the box says on while the
                  // rule is off, and un-ticking it changes nothing the user can see. Indeterminate is
                  // the honest state, and one click still commits an explicit choice either way.
                  checked={config[rule] === true}
                  ref={(element) => {
                    if (element) element.indeterminate = config[rule] === null;
                  }}
                  {...(config[rule] === null ? { 'aria-checked': 'mixed' as const } : {})}
                  disabled={readOnly}
                  onChange={(event) => {
                    if (readOnly) return;
                    onToggle(rule, event.target.checked);
                  }}
                />
                <span className="truncate">{rule}</span>
              </label>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
