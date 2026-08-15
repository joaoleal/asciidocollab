/**
 * @file GENERATED — do not edit.
 *
 * The spellings asciidoctor-pdf 2.3.24's `ThemeLoader` still honours, read from
 * `lib/asciidoctor/pdf/theme_loader.rb` by
 * `packages/shared/scripts/generate-theme-descriptors.mjs`. Regenerate after a gem bump:
 *
 *     `pnpm --filter @asciidocollab/shared generate:theme-descriptors`
 *
 * `process_entry` renames a key BEFORE storing it, and says nothing while doing so. The export
 * therefore applies `sidebar: title: align` exactly as if it had been written `text-align`, and a
 * resolver that keeps the written spelling drops the setting instead — showing a page the export
 * will not produce, with an empty diagnostics list.
 */

/** Categories the loader renames whole, applied to a mapping's own key. */
export const DEPRECATED_THEME_CATEGORIES: Readonly<Record<string, string>> = {
  blockquote: 'quote',
  key: 'kbd',
  literal: 'codespan',
  outline_list: 'list',
};

/** Individual settings the loader renames, applied to a leaf key. */
export const DEPRECATED_THEME_KEYS: Readonly<Record<string, string>> = {
  table_caption_side: 'table_caption_end',
  base_align: 'base_text_align',
  heading_align: 'heading_text_align',
  heading_h1_align: 'heading_h1_text_align',
  heading_h2_align: 'heading_h2_text_align',
  heading_h3_align: 'heading_h3_text_align',
  heading_h4_align: 'heading_h4_text_align',
  heading_h5_align: 'heading_h5_text_align',
  heading_h6_align: 'heading_h6_text_align',
  title_page_align: 'title_page_text_align',
  abstract_align: 'abstract_text_align',
  abstract_title_align: 'abstract_title_text_align',
  admonition_label_align: 'admonition_label_text_align',
  sidebar_title_align: 'sidebar_title_text_align',
  toc_title_align: 'toc_title_text_align',
};

/**
 * The suffix a `role_…` key's alignment is renamed by, which is a rule rather than a table because
 * role names are the author's own.
 */
export const ROLE_ALIGN_SUFFIX = /(?:_text)?_align$/;

/** What {@link ROLE_ALIGN_SUFFIX} is replaced with. */
export const ROLE_ALIGN_REPLACEMENT = '_text_align';
