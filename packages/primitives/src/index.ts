/**
 * @packageDocumentation
 * Primitive types and closed value sets that more than one ring must agree on, with no behaviour
 * attached. Three rules keep the generic name from becoming a junk drawer: zero dependencies
 * permanently, no behaviour beyond type aliases and membership guards, and admission only for
 * types that two rings both need.
 */
export { PREVIEW_STYLE_VALUES, isPreviewStyleValue } from './preview-style';
export type { PreviewStyleValue } from './preview-style';
