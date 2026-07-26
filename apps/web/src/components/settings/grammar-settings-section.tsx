'use client';

import { Label } from '@/components/ui/label';
import { GRAMMAR_DIALECTS, isGrammarDialect, type GrammarDialect } from '@/lib/codemirror/harper/dialect';
import { cn } from '@/lib/utilities';

/** Human-readable dialect labels. */
const DIALECT_LABELS: Readonly<Record<GrammarDialect, string>> = {
  'en-GB': 'British English',
  'en-US': 'American English',
};

/** Props for {@link GrammarSettingsSection}. */
export interface GrammarSettingsSectionProperties {
  /** Whether grammar checking is enabled (defaults to on for English projects when unset). */
  enabled: boolean;
  /** The enforced English dialect. */
  dialect: GrammarDialect;
  /** Whether the project's language is English — the hard gate for the whole feature. */
  languageIsEnglish: boolean;
  /** Whether the caller may change these settings (editor/owner). */
  canEdit: boolean;
  /**
   * Toggle grammar checking on/off.
   *
   * @param next - The new enabled state.
   */
  onEnabledChange: (next: boolean) => void;
  /**
   * Change the enforced English dialect.
   *
   * @param next - The new dialect.
   */
  onDialectChange: (next: GrammarDialect) => void;
}

/**
 * The project-settings section for on-device grammar checking: an enable toggle and an English-dialect
 * selector.
 *
 * Checking only runs when the project language is English, so for any other language the section is
 * inert rather than hidden — a viewer has to be able to see that the setting exists and why it does
 * not apply. Inert means genuinely inert: a disabled `fieldset` takes its heading, description and
 * both controls out of the tab order and refuses clicks, and the whole group is dimmed to the muted
 * treatment the rest of the settings page uses for a control it will not accept. The one thing left
 * at full contrast is the line that says how to enable it, which is the only actionable thing here.
 *
 * @param properties - The current settings and change handlers.
 * @returns The settings section element.
 */
export function GrammarSettingsSection({
  enabled,
  dialect,
  languageIsEnglish,
  canEdit,
  onEnabledChange,
  onDialectChange,
}: GrammarSettingsSectionProperties): React.JSX.Element {
  const disabled = !canEdit || !languageIsEnglish;
  return (
    <div className="flex flex-col gap-3">
      <fieldset
        className="flex flex-col gap-3 disabled:opacity-60"
        disabled={disabled}
        aria-disabled={disabled || undefined}
      >
        <legend className="sr-only">Grammar checking</legend>
        <div>
          <h3 className={cn('text-sm font-medium', disabled && 'text-muted-foreground')}>
            Grammar &amp; spelling checking
          </h3>
          <p className="text-xs text-muted-foreground">
            On-device grammar, spelling, and style checking for everyone editing this project. Only
            available when the project language is English.
          </p>
        </div>

        <label className="flex items-center gap-2">
          {/*
            Disabled on the control as well as on the fieldset around it. The fieldset is what makes
            the heading and description inert too, but not every engine applies an ancestor's disabled
            state to a click's activation behaviour, and a toggle that still fires when it looks
            disabled would write a setting the project cannot use.
          */}
          <input
            type="checkbox"
            checked={enabled && languageIsEnglish}
            disabled={disabled}
            onChange={(event) => onEnabledChange(event.target.checked)}
          />
          <span className={cn(disabled && 'text-muted-foreground')}>Enable grammar checking</span>
        </label>

        <div className="flex flex-col gap-1">
          <Label htmlFor="grammar-dialect" className={cn(disabled && 'text-muted-foreground')}>
            English dialect
          </Label>
          <select
            id="grammar-dialect"
            className="rounded-md border bg-background px-2 py-1 text-sm disabled:opacity-50"
            value={dialect}
            disabled={disabled}
            onChange={(event) => {
              // Narrowed with the shared guard, not a hand-written literal pair: the options are
              // rendered from GRAMMAR_DIALECTS, so a check listing the dialects itself would silently
              // swallow the selection of any dialect added to that list.
              const next = event.target.value;
              if (isGrammarDialect(next)) onDialectChange(next);
            }}
          >
            {GRAMMAR_DIALECTS.map((option) => (
              <option key={option} value={option}>
                {DIALECT_LABELS[option]}
              </option>
            ))}
          </select>
        </div>
      </fieldset>

      {!languageIsEnglish && (
        <p className="text-xs text-muted-foreground">
          Set the project language to English to enable grammar checking.
        </p>
      )}
    </div>
  );
}
