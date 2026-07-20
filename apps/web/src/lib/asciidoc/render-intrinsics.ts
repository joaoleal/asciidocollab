/**
 * The intrinsic attributes Asciidoctor injects for this app's embedded html5/article render — set on
 * every document yet never written as `:name:` lines in the source. They must be in scope wherever the
 * app reasons about what the render will resolve: the preview include assembler's conditional gating
 * and `{attr}` target substitution, and the editor's effective-level walk (so an include guarded by
 * `ifdef::backend-html5[]` is treated consistently in both). Captured from Asciidoctor.js's default
 * attribute set for `load({ safe: 'safe' })` with no explicit doctype/backend override.
 *
 * **HTML preview only.** These describe what the HTML render resolves, and a PDF snapshot must seed
 * {@link PDF_RENDER_INTRINSIC_ATTRIBUTES} instead — see the note there for what went wrong when it
 * did not.
 */
export const RENDER_INTRINSIC_ATTRIBUTES: ReadonlyMap<string, string> = new Map([
  ['backend', 'html5'],
  ['backend-html5', ''],
  ['basebackend', 'html'],
  ['basebackend-html', ''],
  ['filetype', 'html'],
  ['filetype-html', ''],
  ['doctype', 'article'],
  ['doctype-article', ''],
  ['backend-html5-doctype-article', ''],
  ['basebackend-html-doctype-article', ''],
  ['safe-mode-name', 'safe'],
  ['safe-mode-safe', ''],
  ['safe-mode-level', '1'],
]);

/**
 * The same idea for the PDF render: what the PDF backend resolves on every document.
 *
 * A PDF snapshot's `attributes` are handed to `Asciidoctor.convert_file(attributes: …)` as API
 * attributes, and an API attribute **overrides the document header** unless it carries the `@`
 * soft-default marker. Seeding the html5 set there was therefore not a harmless default — it
 * rewrote what every document declared:
 *
 *   - `doctype: article` overrode `:doctype: book`, so no PDF the app produced had a title page or
 *     chapters, whatever the author wrote. The theme editor's own sample declares `:doctype: book`,
 *     and its preview rendered as an article — which is how this was found: the
 *     `per-chapter-contents` and `title-block-document-details` extensions both hook furniture that
 *     only exists in a book, so switching either on visibly did nothing at all.
 *   - `backend: html5` independently did the same damage, and inverted every `ifdef::backend-pdf[]`
 *     and `ifdef::backend-html5[]` gate in a PDF render — each resolving to the opposite of the
 *     truth.
 *
 * Note what is ABSENT here, deliberately: `doctype`. It is not an intrinsic of the backend — it is
 * the document's own declaration, and the renderer derives it from the header. Seeding any value
 * would override that again, which is the whole defect. The `doctype-*` and
 * `backend-…-doctype-…` flags are absent for the same reason.
 *
 * Verified against the canonical toolchain: rendering with exactly these attributes is BYTE-IDENTICAL
 * to rendering with no attributes at all, which is what an intrinsic set should be — visible to code
 * reasoning about the render, inert in the render itself.
 */
export const PDF_RENDER_INTRINSIC_ATTRIBUTES: ReadonlyMap<string, string> = new Map([
  ['backend', 'pdf'],
  ['backend-pdf', ''],
  ['basebackend', 'pdf'],
  ['basebackend-pdf', ''],
  ['filetype', 'pdf'],
  ['filetype-pdf', ''],
  ['safe-mode-name', 'safe'],
  ['safe-mode-safe', ''],
  ['safe-mode-level', '1'],
]);
