/**
 * @file Re-exports the shared export-naming rule for the web app's call sites.
 *
 * The implementation moved to `@asciidocollab/shared` when the API's project-source download adopted
 * the same `<project-slug>-<YYYY-MM-DD>.<ext>` convention: `apps/api` cannot import from `apps/web`, and
 * a second copy of a filename sanitiser would drift from this one silently. This module stays so the
 * web call sites keep a local, intention-revealing import path.
 */
export {
  exportFileName,
  exportSlug,
  FALLBACK_SLUG,
  MAX_SLUG_LENGTH,
  type ExportExtension,
} from '@asciidocollab/shared';
