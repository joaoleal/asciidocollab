import type { PreviewStyleValue } from '@asciidocollab/primitives';

/** DTO representing a user's editor preferences, returned by the API. */
export interface EditorPreferencesDto {
  /** Font size in pixels. */
  fontSize: number;
  /** Editor colour theme identifier. */
  theme: 'default' | 'high-contrast' | 'dracula' | 'tomorrow' | 'espresso';
  /** When true, the preview panel scrolls to track the editor scroll position. */
  scrollSyncEnabled: boolean;
  /** When true, the editor wraps long lines. Defaults to true. */
  softWrap?: boolean;
  /** Preview rendering style token. Defaults to 'asciidocollab'. */
  previewStyle?: PreviewStyleValue;
  /** When false, spellcheck is disabled. The language is a project-level setting. Defaults to true. */
  spellcheckEnabled?: boolean;
  /** When true, the editor shows the document text-preview (minimap). Defaults to false. */
  minimapEnabled?: boolean;
}

/**
 * Selectable spellcheck/document languages — the dictionary-backed set (mirrors the domain's
 * SPELLCHECK_LANGUAGES). The spellcheck language is configured per project, not per user.
 */
export type SpellcheckLanguageDto =
  | 'en' | 'es' | 'fr' | 'pt' | 'de' | 'it' | 'uk' | 'pl' | 'tr';
