"use client";

import { FileCode2, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utilities";
import type { HtmlExportPhase } from "@/hooks/use-html-export";

/** Human-readable progress copy for each export phase, in pipeline order. */
const PHASE_LABELS: Record<HtmlExportPhase, string> = {
  rendering: "Rendering the document…",
  "diagrams-math": "Rendering diagrams and math…",
  assets: "Collecting images and fonts…",
  packaging: "Packaging the download…",
};

/** Shown while exporting before the first phase update lands. */
const COLD_START_LABEL = "Preparing your HTML…";

/** Idle call-to-action copy, also the stable accessible name for the trigger. */
const IDLE_LABEL = "Export to HTML";

/** Presentational contract for the export trigger; all behaviour is injected. */
export interface HtmlExportButtonProperties {
  /** Fired when the user requests an export. */
  onExport: () => void;
  /** Whether an export is currently in flight. */
  isExporting: boolean;
  /** The most recent export phase, when known, driving the progress copy. */
  phase?: HtmlExportPhase;
  /** Disables the trigger while idle (e.g. No root file selected). */
  disabled?: boolean;
  /** Extra design-token classes merged onto the button's root element. */
  className?: string;
}

/** A design-token-styled "Export to HTML" action with a phase spinner, mirroring the PDF trigger. */
export function HtmlExportButton({
  onExport,
  isExporting,
  phase,
  disabled = false,
  className,
}: HtmlExportButtonProperties) {
  const progressLabel = phase ? PHASE_LABELS[phase] : COLD_START_LABEL;

  return (
    <Button
      type="button"
      variant="outline"
      onClick={onExport}
      disabled={disabled || isExporting}
      aria-busy={isExporting}
      className={cn("gap-2", className)}
    >
      {isExporting ? (
        <>
          <Loader2 className="h-4 w-4 animate-spin text-primary" aria-hidden="true" />
          <span role="status" className="text-muted-foreground">
            {progressLabel}
          </span>
        </>
      ) : (
        <>
          <FileCode2 className="h-4 w-4" aria-hidden="true" />
          {IDLE_LABEL}
        </>
      )}
    </Button>
  );
}
