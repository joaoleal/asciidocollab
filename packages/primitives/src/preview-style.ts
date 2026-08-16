/**
 * The set of supported preview style token values (lowercase, as stored and transported).
 *
 * Defined here rather than in `domain`, `shared` or `apps/web` because all four consumers must
 * agree on it and none of them can reach the others: `domain` may depend only inward, `shared`
 * must stay browser-safe, and `apps/web` depends on neither.
 */
export type PreviewStyleValue = 'asciidocollab' | 'asciidoctor' | 'print';

/** Every recognised preview style token, in the order the style control offers them. */
export const PREVIEW_STYLE_VALUES: readonly PreviewStyleValue[] = ['asciidocollab', 'asciidoctor', 'print'];

/**
 * Narrows an arbitrary string to a recognised preview style token.
 *
 * @param value - The candidate token, typically read from storage or a request body.
 * @returns True when `value` names a supported preview style.
 */
export function isPreviewStyleValue(value: string): value is PreviewStyleValue {
  const tokens: readonly string[] = PREVIEW_STYLE_VALUES;
  return tokens.includes(value);
}
