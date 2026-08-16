import { PREVIEW_STYLE_VALUES, isPreviewStyleValue } from '@asciidocollab/primitives';
import type { PreviewStyleValue } from '@asciidocollab/primitives';
import type { Result } from '../../types/result';
import { ValidationError } from '../../errors/common/validation-error';
import { DEFAULT_PREVIEW_STYLE } from '../../constants/editor-preferences';

// Re-exported so existing domain consumers keep their import path; the definition lives in the
// zero-dependency leaf that the browser ring can also reach.
export { isPreviewStyleValue } from '@asciidocollab/primitives';
export type { PreviewStyleValue } from '@asciidocollab/primitives';

/** Validated value object representing a per-user preview rendering style. */
export class PreviewStyle {
  private constructor(public readonly value: PreviewStyleValue) {}

  /**
   * Parses a raw string into a PreviewStyle, returning a failure result if unrecognised.
   *
   * @param raw - The raw style token to validate.
   * @returns A Result containing the PreviewStyle on success, or a ValidationError on failure.
   */
  static parse(raw: string): Result<PreviewStyle, ValidationError> {
    if (isPreviewStyleValue(raw)) {
      return { success: true, value: new PreviewStyle(raw) };
    }
    return {
      success: false,
      error: new ValidationError(`Invalid preview style: "${raw}". Must be one of: ${PREVIEW_STYLE_VALUES.join(', ')}`),
    };
  }

  /** Returns the default preview style (the brand "Asciidocollab" look). */
  static default(): PreviewStyle {
    return new PreviewStyle(DEFAULT_PREVIEW_STYLE);
  }

  /**
   * Parses a raw value, falling back to the default when it is absent or unrecognised.
   * Used at persistence boundaries where a corrupt stored value must not break rendering.
   *
   * @param raw - The raw style token, possibly undefined/invalid.
   * @returns A valid PreviewStyle — the parsed value or the default.
   */
  static parseOrDefault(raw: string | null | undefined): PreviewStyle {
    if (raw != null && isPreviewStyleValue(raw)) {
      return new PreviewStyle(raw);
    }
    return PreviewStyle.default();
  }
}
