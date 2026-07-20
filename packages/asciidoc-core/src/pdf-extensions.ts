/**
 * @file The PDF converter-extension SHAPE, and the ordering rule over it.
 *
 * This is the same story as `theme-file.ts`, for the same reason. The contract crosses four rings —
 * the domain use case that assembles the catalogue, the API route that serves it, the web UI that
 * offers it, and the renderer that loads the code — and it must be declared exactly once or those
 * four come to disagree about what an extension is.
 *
 * It lives in this zero-dependency leaf rather than in `shared` because the renderer
 * (`@asciidocollab/asciidoc-pdf`) is bundled into a Web Worker and depends only on this package.
 * Putting the shape in `shared` would drag the whole domain ring and `zod` into the worker bundle to
 * obtain a handful of interfaces.
 *
 * The split is by JOB, not by convenience: the *shape* and the *ordering rule* are needed everywhere
 * and are pure data, so they are here. The *validation* of an untrusted manifest belongs at the
 * trust boundary where untrusted manifests arrive, needs a schema library, and therefore lives in
 * `shared` — which re-exports everything below so consumers still have one import path.
 */

/** Where an extension's code comes from. Only these two origins are ever loadable. */
export type PdfExtensionOrigin = 'shipped' | 'administrator-provided';

/** The kinds of value an extension-contributed theme setting may take. Mirrors `ThemeValueKind`. */
export type PdfExtensionThemeValueKind =
  | 'colour'
  | 'font'
  | 'measurement'
  | 'keyword'
  | 'number'
  | 'boolean'
  | 'string';

/** One theme setting an extension contributes, offered in the editor only while it is enabled. */
export interface PdfExtensionThemeKey {
  /** Dotted, hyphenated key as the theming guide writes it. */
  readonly key: string;
  /** How the editor should preview and validate this setting's value. */
  readonly valueKind: PdfExtensionThemeValueKind;
  /** One line explaining what the setting does. */
  readonly description: string;
  /** The value applied when the theme does not set it. */
  readonly default?: string;
}

/** What an extension declares about itself. */
export interface PdfExtensionManifest {
  /** Stable identifier; this is what a project's stored selection holds. Never changes. */
  readonly id: string;
  /** Name shown in the extensions catalogue. */
  readonly displayName: string;
  /** What it changes about the output, in the author's terms rather than the implementer's. */
  readonly description: string;
  /**
   * The block attributes or roles an author writes to direct this extension, or empty when it
   * applies document-wide. Shown in the UI so enabling an extension is not a dead end (FR-031a3).
   */
  readonly targeting: string;
  /** Theme settings this extension adds. */
  readonly themeKeys: readonly PdfExtensionThemeKey[];
  /** AsciiDoc the preview sample must contain for this extension's effect to be visible. */
  readonly sampleContent: string;
}

/** A manifest plus the state the server resolves for it. */
export interface PdfExtensionCatalogueEntry {
  /** What the extension declares about itself. */
  readonly manifest: PdfExtensionManifest;
  /** Whether the code ships with the application or came from the administrator's folder. */
  readonly origin: PdfExtensionOrigin;
  /**
   * False when a project has this id enabled but nothing offers it any more.
   *
   * Kept in the catalogue rather than filtered out of it: an administrator can remove an extension a
   * project still uses, and that must reach the owner as a warning instead of silently changing
   * their output (FR-030).
   */
  readonly available: boolean;
}

/**
 * Compare two extension ids deterministically, by Unicode code unit.
 *
 * Ids are restricted to `[a-z0-9-]` (see `pdfExtensionIdSchema`). `localeCompare` collates
 * locale-dependently — notably it can treat the hyphen as ignorable punctuation, ordering
 * `title-block` and `titleblock` differently across ICU versions. Load order can change PDF output,
 * and the feature guarantees the same selection renders identically everywhere (FR-031c, Principle
 * XII), so ordering must not depend on the host's locale data. A raw code-unit comparison is the
 * one collation that is identical in every environment.
 */
export function compareExtensionIds(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * Order catalogue entries deterministically, by id.
 *
 * The renderer loads extensions in the order the catalogue gives them, and load order can change
 * output when two extensions touch the same converter hook. Ordering by id — rather than by the
 * order an administrator's filesystem happened to enumerate them, or the order a project selected
 * them — is what makes the same selection produce the same document every time (FR-031c,
 * Principle XII).
 *
 * @param entries - The entries to order.
 * @returns A new array sorted by id; the input is not mutated.
 */
export function orderPdfExtensions(
  entries: readonly PdfExtensionCatalogueEntry[],
): PdfExtensionCatalogueEntry[] {
  return entries.toSorted((a, b) => compareExtensionIds(a.manifest.id, b.manifest.id));
}
