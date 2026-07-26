'use client';

/**
 * Derives a project's grammar-checking settings — whether checking is active, whether the project
 * language is English, and which English dialect to enforce — from the existing project render-config
 * plus the project language. This is the READ side that gates the linter; the settings page writes the
 * same two config fields through `useProjectRenderConfig` (see `GrammarSettingsSection`), so there is
 * no separate grammar-settings endpoint.
 */
import { useMemo } from 'react';
import { useProjectRenderConfig } from './use-project-render-config';
import { DEFAULT_GRAMMAR_DIALECT, type GrammarDialect } from '@/lib/codemirror/harper/dialect';

/** The resolved grammar settings that gate and configure the on-device linter. */
export interface GrammarSettings {
  /** Whether grammar checking is active (English project AND not disabled in config). */
  enabled: boolean;
  /** Whether the project's configured language is English — the hard gate for the feature (FR-024). */
  languageIsEnglish: boolean;
  /** The English dialect to enforce; defaults to British until a project dialect is configured. */
  dialect: GrammarDialect;
}

/** The inputs `deriveGrammarSettings` reduces to a {@link GrammarSettings}. */
export interface GrammarSettingsInput {
  /** The project's configured language code (`en`, `fr`, …); `uk` is Ukrainian, not UK English. */
  language: string | null | undefined;
  /** The project's `grammarCheckEnabled` config value, if any (absent means enabled for English projects). */
  grammarCheckEnabled?: boolean;
  /** The project's configured English dialect, if any (absent means the default). */
  dialect?: GrammarDialect;
}

/**
 * Pure reduction of a project's language + grammar config into the gate the linter reads. Extracted so
 * the (non-trivial) English-gating and defaulting logic unit-tests without a React renderer.
 *
 * @param input - The project language, enable flag, and dialect.
 * @returns The resolved, read-only grammar settings.
 */
export function deriveGrammarSettings(input: GrammarSettingsInput): GrammarSettings {
  // The project language enum uses plain `en` for English (Ukrainian is `uk`), so English is exact.
  const languageIsEnglish = input.language === 'en';
  const enabled = languageIsEnglish && (input.grammarCheckEnabled ?? true);
  const dialect = input.dialect ?? DEFAULT_GRAMMAR_DIALECT;
  return { enabled, languageIsEnglish, dialect };
}

/** The {@link GrammarSettings} plus whether the underlying render-config has actually been read. */
export interface UseGrammarSettings extends GrammarSettings {
  /** True once the project render-config has loaded (so an unset flag is a real default, not a stale empty). */
  loaded: boolean;
}

/**
 * React hook exposing a project's read-only grammar settings, derived from its render-config and
 * configured language.
 *
 * @param projectId - The project whose render-config supplies the enable flag.
 * @param language - The project's configured language code.
 * @returns The resolved grammar settings plus a `loaded` flag.
 */
export function useGrammarSettings(projectId: string, language: string | null | undefined): UseGrammarSettings {
  const { config, loaded } = useProjectRenderConfig(projectId);
  return useMemo(
    () => ({
      ...deriveGrammarSettings({
        language,
        grammarCheckEnabled: config.grammarCheckEnabled,
        dialect: config.grammarDialect,
      }),
      loaded,
    }),
    [language, config.grammarCheckEnabled, config.grammarDialect, loaded],
  );
}
