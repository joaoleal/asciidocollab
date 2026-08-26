import { EditorPreferencesId } from '../value-objects/ids/editor-preferences-id';
import { EditorTheme } from '../value-objects/editor/editor-theme';
import { PreviewStyle } from '../value-objects/editor/preview-style';
import { UserId } from '../value-objects/ids/user-id';
import { Timestamps } from '../value-objects/common/timestamps';
import { ValidationError } from '../errors/common/validation-error';
import {
  FONT_SIZE_MIN,
  FONT_SIZE_MAX,
  DEFAULT_SPELLCHECK_ENABLED,
  DEFAULT_MINIMAP_ENABLED,
  DEFAULT_PRIVATE_COMMIT_EMAIL,
} from '../constants/editor-preferences';

/** Stores a user's editor display preferences (font size, theme, scroll sync, soft wrap, preview style, spellcheck toggle, minimap toggle, privacy-preserving commit email opt-in). */
export class EditorPreferences {
  public readonly timestamps: Timestamps;

  /**
   * @param id - Unique identifier for this preferences record.
   * @param userId - Owner of this preferences record.
   * @param fontSize - Font size in pixels; must be between FONT_SIZE_MIN and FONT_SIZE_MAX.
   * @param theme - Selected editor theme.
   * @param scrollSyncEnabled - When true, preview scrolls to match editor scroll position.
   * @param timestamps - Optional creation/update timestamps; defaults to now.
   * @param softWrap - When true, the editor wraps long lines instead of scrolling horizontally.
   * @param previewStyle - Selected preview rendering style; defaults to the brand look.
   * @param spellcheckEnabled - When false, spellcheck produces no diagnostics. The
   *  spellcheck language is a project-level setting, not a user preference.
   * @param minimapEnabled - When true, the editor shows the document text-preview (minimap).
   *  Defaults to off.
   * @param privateCommitEmail - When true, a git commit authored by this user records a
   *  deterministic privacy-preserving email instead of the user's real account email (see
   *  `resolveCommitAuthorEmail`). The author's display name is unaffected. Defaults to off.
   */
  constructor(
    public readonly id: EditorPreferencesId,
    public readonly userId: UserId,
    public readonly fontSize: number,
    public readonly theme: EditorTheme,
    public readonly scrollSyncEnabled: boolean = false,
    timestamps?: Timestamps,
    public readonly softWrap: boolean = true,
    public readonly previewStyle: PreviewStyle = PreviewStyle.default(),
    public readonly spellcheckEnabled: boolean = DEFAULT_SPELLCHECK_ENABLED,
    public readonly minimapEnabled: boolean = DEFAULT_MINIMAP_ENABLED,
    public readonly privateCommitEmail: boolean = DEFAULT_PRIVATE_COMMIT_EMAIL,
  ) {
    if (fontSize < FONT_SIZE_MIN || fontSize > FONT_SIZE_MAX) {
      throw new ValidationError(
        `fontSize must be between ${FONT_SIZE_MIN} and ${FONT_SIZE_MAX}, got ${fontSize}`,
      );
    }
    this.timestamps = timestamps ?? new Timestamps();
  }
}
