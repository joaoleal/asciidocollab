import type { EditorPreferencesRepository } from '../../ports/user/editor-preferences.repository';
import type { UserId } from '../../value-objects/ids/user-id';
import type { Result } from '../../types/result';
import { EditorPreferences } from '../../entities/editor-preferences';
import { EditorPreferencesId } from '../../value-objects/ids/editor-preferences-id';
import { EditorTheme } from '../../value-objects/editor/editor-theme';
import { PreviewStyle } from '../../value-objects/editor/preview-style';
import { ValidationError } from '../../errors/common/validation-error';
import {
  DEFAULT_SPELLCHECK_ENABLED,
  DEFAULT_MINIMAP_ENABLED,
  DEFAULT_PRIVATE_COMMIT_EMAIL,
} from '../../constants/editor-preferences';
import { randomUUID } from 'node:crypto';

interface SaveEditorPreferencesInput {
  fontSize: number;
  theme: string;
  scrollSyncEnabled?: boolean;
  softWrap?: boolean;
  previewStyle?: string;
  spellcheckEnabled?: boolean;
  minimapEnabled?: boolean;
  privateCommitEmail?: boolean;
}

/** Validates and persists updated editor preferences for a user. */
export class SaveEditorPreferencesUseCase {
  /** @param repo - The editor preferences repository. */
  constructor(private readonly repo: EditorPreferencesRepository) {}

  /**
   * Executes the use case.
   *
   * @param userId - The user whose preferences to update.
   * @param input - The new preference values to apply.
   * @returns A successful result, or a failure with a validation error.
   */
  async execute(
    userId: UserId,
    input: SaveEditorPreferencesInput,
  ): Promise<Result<void, ValidationError>> {
    const themeResult = EditorTheme.parse(input.theme);
    if (!themeResult.success) {
      return { success: false, error: themeResult.error };
    }

    let prefs: EditorPreferences;
    try {
      const existing = await this.repo.findByUserId(userId);
      const id = existing?.id ?? EditorPreferencesId.create(randomUUID());
      const scrollSyncEnabled = input.scrollSyncEnabled ?? existing?.scrollSyncEnabled ?? false;
      const softWrap = input.softWrap ?? existing?.softWrap ?? true;

      let previewStyle = existing?.previewStyle ?? PreviewStyle.default();
      if (input.previewStyle !== undefined) {
        const previewStyleResult = PreviewStyle.parse(input.previewStyle);
        if (!previewStyleResult.success) {
          return { success: false, error: previewStyleResult.error };
        }
        previewStyle = previewStyleResult.value;
      }

      const spellcheckEnabled = input.spellcheckEnabled ?? existing?.spellcheckEnabled ?? DEFAULT_SPELLCHECK_ENABLED;
      const minimapEnabled = input.minimapEnabled ?? existing?.minimapEnabled ?? DEFAULT_MINIMAP_ENABLED;
      const privateCommitEmail = input.privateCommitEmail ?? existing?.privateCommitEmail ?? DEFAULT_PRIVATE_COMMIT_EMAIL;

      prefs = new EditorPreferences(id, userId, input.fontSize, themeResult.value, scrollSyncEnabled, existing?.timestamps, softWrap, previewStyle, spellcheckEnabled, minimapEnabled, privateCommitEmail);
    } catch (error) {
      if (error instanceof ValidationError) {
        return { success: false, error: error };
      }
      throw error;
    }

    await this.repo.save(prefs);
    return { success: true, value: undefined };
  }
}
