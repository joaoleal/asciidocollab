/**
 * @file The attributes the APP supplies to every render, on top of a project's own render config.
 *
 * Distinct from the two neighbours it sits between:
 *   - {@link ./render-intrinsics} describes what Asciidoctor injects on its own — inert by
 *     construction, never a product decision.
 *   - `resolveRenderAttributes` (packages/shared) maps a project's SAVED render config to attributes;
 *     an empty config resolves to nothing, which is what makes it a faithful mirror of the settings UI.
 *
 * These are neither: they are product defaults for what the app renders when nobody has said anything.
 * Every value carries the Asciidoctor soft-default marker (`@`), so the precedence chain stays
 * document header > project render config > app default.
 */

import { SOFT_DEFAULT_SUFFIX } from '@asciidocollab/shared';

/**
 * `icons=font` by default, so an admonition (NOTE/TIP/WARNING/IMPORTANT/CAUTION) renders with an icon
 * in EVERY project rather than only in those whose header happens to declare `:icons:`.
 *
 * The bug this fixes: the bundled guided-tour project declares `:icons: font`
 * (apps/api/data/demo-project/index.adoc), so its admonitions came up with icons, while a project a
 * user creates — writing the very same `NOTE:` line — got Asciidoctor's attribute-unset fallback, a
 * bare uppercase text label in the icon cell. Both renders are correct AsciiDoc; the app just looked
 * like it rendered admonitions two different ways depending on which project you opened.
 *
 * Why `font` and not `image`: font mode is fully self-contained here. The preview/export stylesheet
 * paints each `<i class="fa icon-note">` with an inline-SVG CSS mask (see the "Admonition icons"
 * block in `styles/asciidoc-preview.css`, mirrored into the standalone HTML export's generated CSS),
 * so nothing fetches Font Awesome, and the PDF engine draws the same family of icons from the
 * prawn-icon glyphs already baked into the wasm build. Image mode instead emits
 * `<img src="{iconsdir}/note.png">`, and `iconsdir` defaults to a project path (`./images/icons`)
 * that a project has no reason to contain — a default of `image` would put a broken-image glyph in
 * every admonition of every project that never asked for icons.
 *
 * Why a soft default and not a forced value: `@` means an author's own choice still wins in full —
 * `:icons: image` (they ship the files), `:icons!:` (they want the plain text label back), or the
 * project's "Admonition icons" setting, which is layered over this map by the composition root.
 *
 * Known trade-off: `icons` is a document-wide attribute, so `font` mode also changes the INLINE
 * `icon:name[]` macro from its `[name]` placeholder text to `<i class="fa fa-name">`, which this app
 * has no Font Awesome font to draw. That macro has never rendered as an icon here (the guided tour
 * already runs in font mode), and the placeholder it loses is not content — whereas admonitions are
 * everywhere. A document that relies on inline icon macros can opt out with `:icons!:`.
 *
 * Deliberately NOT applied inside `buildProjectSnapshot`: that builder is on both sides of the
 * PDF-parity corpus (e2e/pdf-parity), whose committed reference PDFs are rendered by the canonical
 * toolchain from each fixture's declared attributes. A default injected there would appear in the
 * app's render only and break every fixture containing an admonition. The composition root is the
 * honest home for a product default — it is what a real project render goes through, and the parity
 * harness legitimately bypasses it.
 */
export const APP_RENDER_DEFAULT_ATTRIBUTES: Readonly<Record<string, string>> = Object.freeze({
  icons: `font${SOFT_DEFAULT_SUFFIX}`,
});

/**
 * Layer the app's render defaults UNDER `attributes` (a project's resolved render-config map), so any
 * value the project sets — and, via the `@` marker every entry carries, any value the document's own
 * header sets — wins over the default.
 */
export function withAppRenderDefaults(
  attributes: Readonly<Record<string, string>>,
): Record<string, string> {
  return { ...APP_RENDER_DEFAULT_ATTRIBUTES, ...attributes };
}
