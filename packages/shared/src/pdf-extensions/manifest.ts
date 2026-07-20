/**
 * @file The PDF converter-extension contract: what an extension declares about itself, and what the
 * server resolves on top of that.
 *
 * This shape crosses four rings — the domain use case that assembles the catalogue, the API route
 * that serves it, the web UI that offers it, and the renderer that loads the code — so it is defined
 * ONCE here and no other package may redeclare it. Four copies of a DTO is four opportunities for
 * the loader and the UI to disagree about what an extension is.
 *
 * `PdfExtensionManifest` is what the extension file itself declares. `PdfExtensionCatalogueEntry` is
 * that manifest plus the state only the server knows: where it came from, and whether it is still on
 * offer. One derives from the other — they are not two shapes.
 *
 * **Manifests from the administrator's drop folder are untrusted input.** They are files on a disk
 * the application does not control the contents of, so they are validated at the boundary with
 * {@link parsePdfExtensionManifest} before reaching any use case, and a malformed one is excluded
 * with a report rather than crashing the catalogue for every project (FR-033d).
 */

import { z } from 'zod';
import {
  
  
  type PdfExtensionManifest,
  
  
} from '@asciidocollab/asciidoc-core';



/** Upper bounds on manifest strings, so a malformed file cannot produce unbounded UI text. */
const ID_MAX_LEN = 100;
const NAME_MAX_LEN = 120;
const DESCRIPTION_MAX_LEN = 600;
const TARGETING_MAX_LEN = 400;
const SAMPLE_CONTENT_MAX_LEN = 4000;
/** Upper bound on how many theme keys one extension may contribute. */
const THEME_KEYS_MAX = 40;

/**
 * An extension identifier: lowercase alphanumerics and single dashes, nothing else.
 *
 * The character class is load-bearing. An id is resolved by CATALOGUE LOOKUP and is never joined
 * onto a filesystem path — but rejecting separators, dots and whitespace here means an id could not
 * name a path even if some future call site got that wrong. Mirrors the rule the stored project
 * selection is validated against, so an id that survives one check survives the other.
 */
export const pdfExtensionIdSchema = z
  .string()
  .min(1)
  .max(ID_MAX_LEN)
  .regex(/^[a-z\d]+(?:-[a-z\d]+)*$/, {
    message: 'An extension id may contain only lowercase letters, digits and single dashes.',
  });

/** The kinds of value an extension-contributed theme setting may take. Mirrors `ThemeValueKind`. */
export const themeValueKindSchema = z.enum([
  'colour',
  'font',
  'measurement',
  'keyword',
  'number',
  'boolean',
  'string',
]);

/**
 * One theme setting an extension contributes.
 *
 * These are merged into the theme editor's completion catalogue ONLY while the extension is enabled
 * — completing a key nothing will read gives the author no feedback that their setting is inert
 * (FR-031b, invariant D5).
 */
export const pdfExtensionThemeKeySchema = z
  .object({
    /** Dotted, hyphenated key as the theming guide writes it. */
    key: z.string().min(1).max(ID_MAX_LEN),
    /** How the editor should preview and validate this setting's value. */
    valueKind: themeValueKindSchema,
    /** One line explaining what the setting does. */
    description: z.string().min(1).max(DESCRIPTION_MAX_LEN),
    /** The value applied when the theme does not set it. */
    default: z.string().max(NAME_MAX_LEN).optional(),
  })
  .strict();

/** What an extension declares about itself. */
export const pdfExtensionManifestSchema = z
  .object({
    /** Stable identifier; this is what a project's stored selection holds. Never changes. */
    id: pdfExtensionIdSchema,
    /** Name shown in the extensions catalogue. */
    displayName: z.string().min(1).max(NAME_MAX_LEN),
    /** What it changes about the output, in the author's terms rather than the implementer's. */
    description: z.string().min(1).max(DESCRIPTION_MAX_LEN),
    /**
     * The block attributes or roles an author writes to direct this extension, or empty when it
     * applies document-wide. Shown in the UI so enabling an extension is not a dead end (FR-031a3).
     */
    targeting: z.string().max(TARGETING_MAX_LEN).default(''),
    /** Theme settings this extension adds, offered in the editor only while it is enabled. */
    themeKeys: z.array(pdfExtensionThemeKeySchema).max(THEME_KEYS_MAX).default([]),
    /**
     * AsciiDoc the preview sample must contain for this extension's effect to be visible. An
     * extension whose effect the sample cannot demonstrate must not ship (FR-011a, SC-014b).
     */
    sampleContent: z.string().max(SAMPLE_CONTENT_MAX_LEN).default(''),
  })
  .strict();

/** Where an extension's code comes from. */
export const pdfExtensionOriginSchema = z.enum(['shipped', 'administrator-provided']);

/**
 * The validated manifest shape. Structurally identical to the leaf's {@link PdfExtensionManifest} —
 * asserted by a test — so validation produces exactly the contract every other ring consumes.
 */
export type ValidatedPdfExtensionManifest = z.infer<typeof pdfExtensionManifestSchema>;

/** Why a manifest was rejected, so the catalogue can report what it excluded rather than hide it. */
export interface PdfExtensionManifestProblem {
  /** The file or directory the manifest came from. */
  readonly source: string;
  /** What was wrong with it, in terms an administrator can act on. */
  readonly reason: string;
}

/** The outcome of parsing an untrusted manifest. */
export type ParsedPdfExtensionManifest =
  | { readonly ok: true; readonly manifest: PdfExtensionManifest }
  | { readonly ok: false; readonly reason: string };

/**
 * Validate an untrusted manifest read from the administrator's drop folder.
 *
 * Returns a result rather than throwing because ONE malformed manifest must not deny every project
 * its catalogue — the caller excludes it, reports it, and carries on (FR-033d).
 *
 * @param raw - The parsed file contents, of unknown shape.
 * @returns The validated manifest, or the reason it was rejected.
 */
export function parsePdfExtensionManifest(raw: unknown): ParsedPdfExtensionManifest {
  const result = pdfExtensionManifestSchema.safeParse(raw);
  if (result.success) return { ok: true, manifest: result.data };
  const reason = result.error.issues
    .map((issue) => `${issue.path.join('.') || 'manifest'}: ${issue.message}`)
    .join('; ');
  return { ok: false, reason };
}


export {orderPdfExtensions, compareExtensionIds, type PdfExtensionCatalogueEntry, type PdfExtensionOrigin, type PdfExtensionThemeKey, type PdfExtensionManifest} from '@asciidocollab/asciidoc-core';