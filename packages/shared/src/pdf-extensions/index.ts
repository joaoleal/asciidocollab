/** @file Barrel for the PDF converter-extension contract, defined once and shared by all four rings. */

export {
  pdfExtensionIdSchema,
  pdfExtensionManifestSchema,
  pdfExtensionThemeKeySchema,
  pdfExtensionOriginSchema,
  themeValueKindSchema,
  type ValidatedPdfExtensionManifest,
  parsePdfExtensionManifest,
  orderPdfExtensions,
  compareExtensionIds,
  type PdfExtensionManifest,
  type PdfExtensionThemeKey,
  type PdfExtensionOrigin,
  type PdfExtensionCatalogueEntry,
  type PdfExtensionManifestProblem,
  type ParsedPdfExtensionManifest,
} from './manifest';
