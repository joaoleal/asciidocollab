/**
 * @file The one place the Print style's own diagnostics become something the shared surface can show.
 *
 * The theme resolver lives in `packages/shared` and the PDF renderer in `packages/asciidoc-pdf`;
 * neither may depend on the other, so their diagnostic types are deliberately separate rather than
 * one type defined twice. They are reconciled here, in the layer that already imports both — which
 * is what makes reporting both through one panel reuse rather than duplication in disguise.
 *
 * The mapping is narrow on purpose. A `themeKey` and a diagnostic `code` are how this feature's own
 * code reasons about a problem; neither means anything to an author reading a list of them, and
 * neither belongs on the surface.
 */

import type { AppearanceDiagnostic } from '@asciidocollab/shared';
import type { ReportedDiagnostic } from '@/components/pdf-diagnostics';

/**
 * Present one appearance diagnostic on the shared diagnostics surface.
 *
 * @param diagnostic - A problem found while reading the theme or loading its fonts.
 * @returns The same problem in the shape the surface reports.
 */
export function toDiagnosticProperties(diagnostic: AppearanceDiagnostic): ReportedDiagnostic {
  return {
    severity: diagnostic.severity,
    message: diagnostic.message,
    resource: diagnostic.resource,
    ...(diagnostic.location === undefined
      ? {}
      : {
          location: {
            path: diagnostic.location.path,
            ...(diagnostic.location.line === undefined ? {} : { line: diagnostic.location.line }),
          },
        }),
  };
}

/**
 * Present every appearance diagnostic, in the order they were found.
 *
 * @param diagnostics - The problems to report.
 * @returns The same problems in the shape the surface reports.
 */
export function toDiagnosticPropertiesList(
  diagnostics: readonly AppearanceDiagnostic[],
): readonly ReportedDiagnostic[] {
  return diagnostics.map((diagnostic) => toDiagnosticProperties(diagnostic));
}
