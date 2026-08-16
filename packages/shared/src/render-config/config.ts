/**
 * @file The project-level render-configuration model: the set of AsciiDoc / Asciidoctor-PDF options a
 * project may define ONCE and have applied to every document it renders — in both the live HTML preview
 * and the in-browser PDF export. This is the single source of truth for which options exist, how each
 * maps to an Asciidoctor attribute, and which attribute names may NEVER be set from here because the
 * render engines pin them (`base_dir`, `pdf-fontsdir`, …) or they are security-sensitive.
 *
 * The resolver in `./resolve` turns a validated {@link RenderConfig} into the attribute map both engines
 * consume; this module only defines and validates the config.
 */

import { z } from 'zod';
import type { PreviewStyleValue } from '@asciidocollab/primitives';
import { grammarDialectSchema } from '../grammar/grammar-config';

/** Upper bound on a single free-form custom-attribute name/value, and on the number of them. */
const CUSTOM_ATTR_MAX_LEN = 200;
const CUSTOM_ATTR_MAX_COUNT = 100;
/** Upper bound on a single string-valued option and on the count/length of custom font directories. */
const STRING_OPTION_MAX_LEN = 200;
const FONT_DIR_MAX_COUNT = 20;

/** Upper bound on how many converter extensions one project may enable. */
const EXTENSION_MAX_COUNT = 100;
/** Upper bound on a single extension identifier. */
const EXTENSION_ID_MAX_LEN = 100;

/**
 * A converter-extension identifier: lowercase alphanumerics and dashes, nothing else.
 *
 * The character class is the point. An id is resolved by looking it up in the catalogue and is never
 * joined onto a filesystem path — but rejecting separators, dots and whitespace here means a stored
 * selection could not name a path even if some future call site got that wrong.
 */
const extensionIdSchema = z
  .string()
  .min(1)
  .max(EXTENSION_ID_MAX_LEN)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, {
    message: 'An extension id may contain only lowercase letters, digits and single dashes.',
  });

/** Asciidoctor-PDF named page sizes exposed in the UI (passed through verbatim as `pdf-page-size`). */
export const PDF_PAGE_SIZES = ['A3', 'A4', 'A5', 'LETTER', 'LEGAL', 'LEDGER', 'TABLOID'] as const;

/** How an HTML export is delivered: one portable file, or a zip with the assets kept separate. */
export const HTML_EXPORT_PACKAGINGS = ['single-file', 'zip'] as const;
/**
 * The visual style an HTML export is dressed in: the app's own stylesheet, or the vendored
 * Asciidoctor default.
 *
 * These were once exactly the styles the live preview offered, so a project pinning a style named the
 * same thing a reader saw on screen. The preview has since gained the Print style, which has no HTML
 * export counterpart — it reproduces a page the export does not paginate. The two lists are therefore
 * no longer identical, and {@link htmlExportStyleFor} is the one place that reconciles them.
 */
export const HTML_EXPORT_STYLES = ['asciidocollab', 'asciidoctor'] as const;
/** The palette baked into an HTML export; `auto` emits both under `prefers-color-scheme`. */
export const HTML_EXPORT_THEMES = ['light', 'dark', 'auto'] as const;

/** How an HTML export is delivered. */
export type HtmlExportPackaging = (typeof HTML_EXPORT_PACKAGINGS)[number];
/** The visual style an HTML export is dressed in. */
export type HtmlExportStyle = (typeof HTML_EXPORT_STYLES)[number];
/** The palette baked into an HTML export. */
export type HtmlExportTheme = (typeof HTML_EXPORT_THEMES)[number];

/**
 * The export style that corresponds to a reader's preview style.
 *
 * Every preview style but Print names an export style directly. Print does not: it dresses the
 * preview as a page, which an unpaginated HTML export cannot be, so a reader with Print selected
 * exports in the application's own styling rather than in nothing at all.
 *
 * @param previewStyle - The reader's current preview style token.
 * @returns The export style to dress the download in.
 */
export function htmlExportStyleFor(previewStyle: PreviewStyleValue): HtmlExportStyle {
  return previewStyle === 'asciidoctor' ? 'asciidoctor' : 'asciidocollab';
}

/**
 * The packaging used when a project has expressed no preference: one self-contained file. Chosen as
 * the default because it is the only form that survives being forwarded on its own — a loose
 * `index.html` from a zip is useless without the folder that came with it.
 */
export const DEFAULT_HTML_EXPORT_PACKAGING: HtmlExportPackaging = 'single-file';
/**
 * The palette used when a project has expressed no preference. Light, because an export is a document
 * to be read, shared and printed, and because the vendored Asciidoctor stylesheet is light-only — so
 * light is the one choice under which both preview styles agree.
 */
export const DEFAULT_HTML_EXPORT_THEME: HtmlExportTheme = 'light';

/**
 * Attribute names a project-level config MUST NOT set — either the render engines pin them (setting
 * them breaks include/image resolution or asset mounting) or they are security-sensitive. Custom
 * attributes are filtered against this set, and no curated option maps to any of these. Compared
 * case-insensitively; see `resolveRenderAttributes`.
 */
export const PINNED_ATTRIBUTE_KEYS: ReadonlySet<string> = new Set([
  // Engine-pinned path/resolution roots (hardcoded to /project or derived from mounted assets).
  'base_dir',
  'basedir',
  'docdir',
  'docfile',
  'docname',
  'outdir',
  'to_dir',
  'to-dir',
  'imagesoutdir',
  'pdf-themesdir',
  'pdf-fontsdir',
  // Divergent between the HTML and PDF engines — cannot be honoured identically.
  'source-highlighter',
  // HTML asset control owned by the app's scoped stylesheet.
  'stylesheet',
  'stylesdir',
  'linkcss',
  'copycss',
  // Security-sensitive: the sandbox boundary and remote-fetch policy are not user-configurable.
  'safe',
  'safe-mode-level',
  'allow-uri-read',
  'max-include-depth',
  // Raw-HTML injection vector: docinfo files are embedded verbatim by the HTML engine below the
  // SECURE safe mode the preview worker runs at, so they must never be enabled from project config.
  'docinfo',
  'docinfo1',
  'docinfo2',
  'docinfodir',
]);

/**
 * The project-level render configuration. Every field is optional: an absent field means "leave the
 * engine default", a present field becomes an overridable soft-default a document header may still win
 * over. Stored as JSON and validated with {@link renderConfigSchema}.
 */
export const renderConfigSchema = z
  .object({
    // --- Core document behaviour ---
    /** `article` (default) or `book`; changes page/chapter model. */
    doctype: z.enum(['article', 'book']).optional(),
    /** Render a table of contents. */
    toc: z.boolean().optional(),
    /** Depth of the table of contents. */
    toclevels: z.number().int().min(1).max(5).optional(),
    /** Number sections. */
    sectnums: z.boolean().optional(),
    /** Depth to which sections are numbered. */
    sectnumlevels: z.number().int().min(0).max(5).optional(),
    /** Admonition icon style: font glyphs or the default image set. */
    icons: z.enum(['font', 'image']).optional(),
    /** Enable experimental macros (kbd:, btn:, menu:). */
    experimental: z.boolean().optional(),
    /** Treat every newline as a hard line break. */
    hardbreaks: z.boolean().optional(),

    // --- On-device grammar & spelling checking ---
    /**
     * Enable on-device grammar, spelling, and style checking. Only meaningful — and only active — when
     * the project's configured language is English (spec FR-024); the web hook treats an absent value
     * as enabled for English projects. This is checker configuration, not a render attribute, so the
     * resolver ignores it.
     */
    grammarCheckEnabled: z.boolean().optional(),
    /**
     * The English dialect grammar checking enforces (spec FR-023). Only meaningful when the project
     * language is English; the web hook defaults an absent value to British. Checker configuration, not
     * a render attribute — the resolver ignores it.
     *
     * Uses the shared `grammarDialectSchema` rather than restating the enum: this is the only endpoint
     * that carries a dialect, so an inline copy here would have made the "single validation authority"
     * in `grammar/grammar-config.ts` a claim with no consumer, free to drift from the value the editor
     * actually enforces.
     */
    grammarDialect: grammarDialectSchema.optional(),

    // --- Paths / resolution ---
    /** Base directory (prefix) for image macro targets. */
    imagesdir: z.string().trim().max(STRING_OPTION_MAX_LEN).optional(),
    /**
     * Extra project-relative directories to APPEND to the font search path (never replace it). Each is
     * sandbox-resolved in the web layer before it reaches the engine; short relative paths are expected.
     */
    extraFontDirs: z
      .array(z.string().trim().min(1).max(STRING_OPTION_MAX_LEN))
      .max(FONT_DIR_MAX_COUNT)
      .optional(),
    /** Bibliography source file (project-relative); else the first `.bib` is auto-discovered. */
    bibtexFile: z.string().trim().max(STRING_OPTION_MAX_LEN).optional(),
    /** CSL style the citations are formatted with (e.g. `apa`, `ieee`). */
    bibtexStyle: z.string().trim().max(STRING_OPTION_MAX_LEN).optional(),
    /** Reference-list ordering. */
    bibtexOrder: z.enum(['appearance', 'alphabetical']).optional(),

    // --- Asciidoctor-PDF layout (ignored by the HTML engine) ---
    /** Selects a project theme by name (`<name>-theme.yml`, discovered anywhere in the tree). */
    pdfTheme: z.string().trim().max(STRING_OPTION_MAX_LEN).optional(),
    /** Output target: on-screen, print, or prepress (crop marks + recto/verso). */
    media: z.enum(['screen', 'print', 'prepress']).optional(),
    /** Named page size. */
    pdfPageSize: z.enum(PDF_PAGE_SIZES).optional(),
    /** Page orientation. */
    pdfPageLayout: z.enum(['portrait', 'landscape']).optional(),
    /** Enable hyphenation (uses `lang` for the hyphenation dictionary). */
    hyphens: z.boolean().optional(),
    /** Shrink oversized verbatim blocks to fit the content width. */
    autofit: z.boolean().optional(),
    /** Folio (page-side) placement strategy, meaningful with `media: prepress`. */
    pdfFolioPlacement: z.enum(['virtual', 'physical', 'physical-inverted']).optional(),

    // --- Free-form custom attributes (filtered against PINNED_ATTRIBUTE_KEYS) ---
    /** Arbitrary shared attributes ({company}, {version}, …), injected as overridable soft-defaults. */
    customAttributes: z
      .record(
        z.string().trim().min(1).max(CUSTOM_ATTR_MAX_LEN),
        z.string().max(CUSTOM_ATTR_MAX_LEN),
      )
      .refine((map) => Object.keys(map).length <= CUSTOM_ATTR_MAX_COUNT, {
        message: `At most ${CUSTOM_ATTR_MAX_COUNT} custom attributes are allowed.`,
      })
      .optional(),

    // --- HTML export ---
    /**
     * How the HTML export is delivered and how it looks standing on its own.
     *
     * Neither field is an Asciidoctor attribute, so the resolver emits nothing for them — they
     * describe the FILE the export produces, not the document the engine renders. They live here
     * rather than in a user preference because both are properties of the artifact a project hands
     * out: everyone exporting the same project should produce the same shape of file.
     */
    htmlExport: z
      .object({
        /**
         * `single-file` (default) inlines every asset as a `data:` URI so the export is one portable
         * file; `zip` writes `index.html` beside an `assets/` folder, which stays smaller and keeps
         * images as real files at the cost of needing to be unpacked before it can be read.
         */
        packaging: z.enum(HTML_EXPORT_PACKAGINGS).optional(),
        /**
         * Which stylesheet the export is dressed in. ABSENT means "whatever the person exporting has
         * selected in their own preview" — the style is a reading preference on screen, so leaving it
         * unset keeps that freedom. Setting it pins the style for everyone, which is what a project
         * handing out a document with a house look needs.
         */
        style: z.enum(HTML_EXPORT_STYLES).optional(),
        /**
         * Which palette is baked into the exported file. The app's own stylesheet is written against
         * theme tokens that only resolve inside the app, so an export has to commit to real colours:
         * `light` (default) always, `dark` always, or `auto` to emit both under
         * `prefers-color-scheme` and let the reader's system decide. The vendored Asciidoctor
         * stylesheet is light-only upstream, so this only changes the app's own style.
         */
        theme: z.enum(HTML_EXPORT_THEMES).optional(),
      })
      .strict()
      .optional(),

    // --- PDF converter extensions ---
    /**
     * Which deployment-provided converter extensions this project applies. Identifiers ONLY: every
     * extension's code lives in the deployment (the shipped gem or the administrator's folder), so a
     * project's stored selection is a list of names and can carry nothing executable.
     *
     * Ids that no longer match a catalogue entry are deliberately KEPT here rather than filtered —
     * an administrator can remove an extension a project still has enabled, and that stale selection
     * must reach the owner as a warning instead of vanishing.
     */
    extensions: z
      .object({
        enabled: z.array(extensionIdSchema).max(EXTENSION_MAX_COUNT).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

/** A validated project-level render configuration. */
export type RenderConfig = z.infer<typeof renderConfigSchema>;

/**
 * Validate and normalize an untrusted config value (drops unknown keys via `.strict` failing, coerces
 * types). Throws a {@link z.ZodError} on invalid input.
 */
export function normalizeRenderConfig(raw: unknown): RenderConfig {
  return renderConfigSchema.parse(raw);
}

/** Like {@link normalizeRenderConfig} but returns a discriminated result instead of throwing. */
export function safeNormalizeRenderConfig(
  raw: unknown,
): ReturnType<typeof renderConfigSchema.safeParse> {
  return renderConfigSchema.safeParse(raw);
}

/** The empty configuration — every option left at the engine default. */
export const EMPTY_RENDER_CONFIG: RenderConfig = Object.freeze({});
