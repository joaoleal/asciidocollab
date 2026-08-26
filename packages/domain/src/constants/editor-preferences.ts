export const FONT_SIZE_MIN = 8;
export const FONT_SIZE_MAX = 32;
export const DEFAULT_FONT_SIZE = 14;
export const DEFAULT_THEME = 'default' as const;
export const DEFAULT_SCROLL_SYNC_ENABLED = false;
export const DEFAULT_PREVIEW_STYLE = 'asciidocollab' as const;

/** The document text-preview (minimap) is off by default — it is an opt-in aid, not a baseline. */
export const DEFAULT_MINIMAP_ENABLED = false;

/**
 * The privacy-preserving commit-author-email opt-in is off by default — a commit is authored under
 * the user's real account email unless they explicitly choose otherwise.
 */
export const DEFAULT_PRIVATE_COMMIT_EMAIL = false;

/**
 * Selectable editor spellcheck languages (ISO 639-1 codes). The list is limited to languages with a
 * bundled Hunspell dictionary that actually spell-check — offering a language that produces no
 * diagnostics would be misleading. Hunspell does not suit CJK / most Indic / Arabic-script
 * languages, so those are intentionally absent; to turn spellcheck off, use the enable/disable flag.
 */
export const SPELLCHECK_LANGUAGES = [
  'en', 'es', 'fr', 'pt', 'de', 'it', 'uk', 'pl', 'tr',
] as const;

/** A selectable spellcheck/document language code (one of {@link SPELLCHECK_LANGUAGES}). */
export type SpellcheckLanguage = (typeof SPELLCHECK_LANGUAGES)[number];

export const DEFAULT_SPELLCHECK_LANGUAGE = 'en' as const;
export const DEFAULT_SPELLCHECK_ENABLED = true;

const SPELLCHECK_LANGUAGE_SET: ReadonlySet<string> = new Set(SPELLCHECK_LANGUAGES);

/** Whether `value` is one of the selectable spellcheck languages. */
export function isSpellcheckLanguage(value: string): value is SpellcheckLanguage {
  return SPELLCHECK_LANGUAGE_SET.has(value);
}
