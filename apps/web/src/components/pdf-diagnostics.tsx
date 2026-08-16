"use client";

import { useId, useMemo, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utilities";

/**
 * What this panel needs of a diagnostic, and nothing more.
 *
 * Two modules produce per-resource diagnostics — the PDF renderer and the Print preview's theme
 * resolver — and they live in packages that may not depend on each other, so their diagnostic types
 * cannot be unified. Stating the structural minimum here is what lets one surface report both
 * without this component depending on either concrete type: each satisfies these fields, and neither
 * is imported.
 */

/** How severe a diagnostic is; errors are listed before warnings. */
export type DiagnosticSeverity = "error" | "warning";

/** A source location the editor can jump to when a diagnostic carries one. */
export interface DiagnosticLocation {
  /** Project-relative path of the document the problem is in. */
  readonly path: string;
  /** 1-based line, when the problem has one. */
  readonly line?: number;
}

/** One reported problem, in the shape both producers satisfy. */
export interface ReportedDiagnostic {
  /** How severe it is. */
  readonly severity: DiagnosticSeverity;
  /** What went wrong, in the words shown to the author. */
  readonly message: string;
  /** What it concerns — a file, an image, a font — used as the row's label. */
  readonly resource: string;
  /** Where in a document it is, when that is known. */
  readonly location?: DiagnosticLocation;
}

/** The default header/intro/aria copy — the PDF export surface this panel was first built for. */
const PDF_DIAGNOSTICS_COPY = {
  title: "PDF diagnostics",
  intro: "The PDF was produced. The following items were skipped or adjusted.",
  ariaLabel: "PDF export diagnostics",
} as const;

/** Bindings for the per-resource render-diagnostics surface (PDF export or on-screen preview). */
export interface PdfDiagnosticsProperties {
  /** Non-fatal warnings and per-resource errors gathered while producing the output. */
  diagnostics: readonly ReportedDiagnostic[];
  /**
   * Invoked with a diagnostic's source location so the editor can reveal it.
   *
   * @param location - The diagnostic's source location to reveal in the editor.
   */
  onSelectLocation?: (location: DiagnosticLocation) => void;
  /** Collapsed-header label. Defaults to the PDF-export copy. */
  title?: string;
  /** One-line explanation shown above the list when expanded. Defaults to the PDF-export copy. */
  intro?: string;
  /** Accessible section label. Defaults to the PDF-export copy. */
  ariaLabel?: string;
}

/**
 * The severities in display order: errors first, then warnings. Anchored to the
 * {@link DiagnosticSeverity} type so it cannot drift from the protocol.
 */
const SEVERITY_ORDER: readonly DiagnosticSeverity[] = ["error", "warning"];

/** Design-token classes per severity — destructive for errors, warning tokens for warnings. */
const SEVERITY_STYLES: Record<
  DiagnosticSeverity,
  { readonly row: string; readonly label: string }
> = {
  error: {
    row: "border-destructive/40 bg-destructive/10",
    label: "text-destructive",
  },
  warning: {
    row: "border-[hsl(var(--warning-border))] bg-[hsl(var(--warning-bg))]",
    label: "text-[hsl(var(--warning))]",
  },
};

const SEVERITY_LABEL: Record<DiagnosticSeverity, string> = {
  error: "Error",
  warning: "Warning",
};

/**
 * The most rows this panel builds, whatever it is handed.
 *
 * A producer can hand over a list as long as its input: a theme document naming one setting per line
 * produced one diagnostic per line, tens of thousands of them, and every one became a DOM node —
 * expanded by default, re-sorted on each render, beside a preview that re-renders as the author
 * types. What is past the bound is counted rather than dropped silently; the row below says so.
 */
const MAX_LISTED = 50;

function severityRank(severity: DiagnosticSeverity): number {
  return SEVERITY_ORDER.indexOf(severity);
}

function locationSummary(location: DiagnosticLocation): string {
  return location.line === undefined
    ? location.path
    : `${location.path}:${location.line}`;
}

/** Pluralize a count for the header summary (e.g. "1 error", "3 warnings"). */
function countLabel(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** A short "N errors, M warnings" summary for the collapsed header (omits any zero group). */
function summarize(diagnostics: readonly ReportedDiagnostic[]): string {
  const errors = diagnostics.filter((d) => d.severity === "error").length;
  const warnings = diagnostics.length - errors;
  const parts: string[] = [];
  if (errors > 0) parts.push(countLabel(errors, "error"));
  if (warnings > 0) parts.push(countLabel(warnings, "warning"));
  return parts.join(", ");
}

/**
 * A collapsible surface for the non-fatal diagnostics that ride alongside a produced PDF. The export
 * always succeeds; the items listed here were skipped or adjusted. A header shows an errors/warnings
 * summary and toggles the body open or closed; the body is height-capped and scrolls so a long list
 * never pushes the surrounding editor chrome off-screen. Errors are shown before warnings, and a
 * diagnostic with a known source location offers a click-to-locate control. Renders nothing when there
 * are no diagnostics.
 */
export function PdfDiagnostics({
  diagnostics,
  onSelectLocation,
  title = PDF_DIAGNOSTICS_COPY.title,
  intro = PDF_DIAGNOSTICS_COPY.intro,
  ariaLabel = PDF_DIAGNOSTICS_COPY.ariaLabel,
}: PdfDiagnosticsProperties) {
  const [collapsed, setCollapsed] = useState(false);
  const bodyId = useId();

  // Sorted once per list rather than once per render: this panel sits beside a live preview, so it
  // re-renders on things that have nothing to do with its own contents.
  const ordered = useMemo(
    () =>
      diagnostics
        .toSorted((a, b) => severityRank(a.severity) - severityRank(b.severity))
        .slice(0, MAX_LISTED),
    [diagnostics]
  );
  const withheld = Math.max(0, diagnostics.length - MAX_LISTED);

  if (diagnostics.length === 0) return null;

  const ChevronIcon = collapsed ? ChevronRight : ChevronDown;

  return (
    <section
      aria-label={ariaLabel}
      className="rounded-md border border-border bg-card text-sm"
    >
      <button
        type="button"
        onClick={() => setCollapsed((value) => !value)}
        aria-expanded={!collapsed}
        aria-controls={bodyId}
        className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ChevronIcon
          className="h-4 w-4 shrink-0 text-muted-foreground"
          aria-hidden="true"
        />
        <span className="font-medium text-foreground">{title}</span>
        <span className="text-xs text-muted-foreground">
          {summarize(diagnostics)}
        </span>
      </button>
      {collapsed ? null : (
        <div id={bodyId}>
          <p className="px-3 text-muted-foreground">{intro}</p>
          <ul
            role="list"
            className="flex max-h-64 flex-col gap-2 overflow-y-auto p-3"
          >
            {ordered.map((diagnostic, index) => {
              const styles = SEVERITY_STYLES[diagnostic.severity];
              const { location } = diagnostic;
              return (
                <li
                  key={`${diagnostic.severity}-${diagnostic.resource}-${index}`}
                  className={cn(
                    "flex flex-col gap-1 rounded-md border p-2",
                    styles.row
                  )}
                >
                  <div className="flex items-center gap-2">
                    <span
                      className={cn(
                        "text-xs font-semibold uppercase tracking-wide",
                        styles.label
                      )}
                    >
                      {SEVERITY_LABEL[diagnostic.severity]}
                    </span>
                    <span className="text-foreground">{diagnostic.message}</span>
                  </div>
                  <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <span className="font-mono">{diagnostic.resource}</span>
                    {location !== undefined && onSelectLocation !== undefined ? (
                      <button
                        type="button"
                        onClick={() => onSelectLocation(location)}
                        className="rounded-sm text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                      >
                        {`Go to ${locationSummary(location)}`}
                      </button>
                    ) : null}
                  </div>
                </li>
              );
            })}
            {withheld === 0 ? null : (
              <li className="rounded-md border border-border p-2 text-xs text-muted-foreground">
                {`${countLabel(withheld, "further item")} not listed.`}
              </li>
            )}
          </ul>
        </div>
      )}
    </section>
  );
}
