'use client';
import { PdfDiagnostics } from '@/components/pdf-diagnostics';
import type { useProjectGit } from './use-project-git';
import type { useEditorRenderPipeline } from './use-editor-render-pipeline';

interface EditorStatusBannersProperties {
  git: ReturnType<typeof useProjectGit>;
  pipeline: ReturnType<typeof useEditorRenderPipeline>;
}

/**
 * The status strips that appear below the editor header: the git pull/push/branch-switch outcomes
 * and the PDF/HTML export outcomes (fatal failures plus non-fatal per-resource diagnostics).
 */
export function EditorStatusBanners({ git, pipeline }: EditorStatusBannersProperties) {
  const { pull, push, branches, undoMessage } = git;
  const { exportError, exportDiagnostics, htmlExportError, htmlExportFailures, handleDiagnosticLocation } = pipeline;
  return (
    <>
      {/* Pull outcome: a synchronous start failure, or the polled operation settling into something
          other than success. AWAITING_CONFLICT is deliberately neutral (`role="status"`), not an
          error — resolving conflicts is a separate flow this task does not build. */}
      {pull.message && pull.message.tone === 'error' && (
        <div role="alert" className="shrink-0 border-b border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {pull.message.text}
        </div>
      )}
      {pull.message && pull.message.tone === 'neutral' && (
        <div role="status" className="shrink-0 border-b px-3 py-2 text-sm text-muted-foreground">
          {pull.message.text}
        </div>
      )}

      {/* Push outcome: a synchronous start failure, or the polled operation settling into something
          other than success (including a non-fast-forward refusal) — a push has no neutral outcome. */}
      {push.message && (
        <div role="alert" className="shrink-0 border-b border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {push.message.text}
        </div>
      )}

      {/* Branch switch outcome: a synchronous start failure, or the polled operation settling into
          something other than success. AWAITING_CONFLICT is deliberately neutral, same as pull's. */}
      {branches.switchMessage && branches.switchMessage.tone === 'error' && (
        <div role="alert" className="shrink-0 border-b border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {branches.switchMessage.text}
        </div>
      )}
      {branches.switchMessage && branches.switchMessage.tone === 'neutral' && (
        <div role="status" className="shrink-0 border-b px-3 py-2 text-sm text-muted-foreground">
          {branches.switchMessage.text}
        </div>
      )}

      {/* Undo outcome: the status bar's transient "✓ Pulled — Undo" / "✓ Switched to <branch> —
          Undo" affordance clicked and refused. A `nothing_to_undo` refusal clears the affordance
          quietly instead of landing here — see `useProjectGit`'s `undoLast`. */}
      {undoMessage && (
        <div role="alert" className="shrink-0 border-b border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {undoMessage.text}
        </div>
      )}

      {/* PDF export outcome: a fatal failure alert and/or the non-fatal per-resource diagnostics
          (the export still succeeded). Both surface below the header and clear on the next export. */}
      {exportError && (
        <div role="alert" className="shrink-0 border-b border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {`Export to PDF failed: ${exportError.message}`}
        </div>
      )}
      {exportDiagnostics.length > 0 && (
        <div className="shrink-0 border-b px-3 py-2">
          <PdfDiagnostics diagnostics={exportDiagnostics} onSelectLocation={handleDiagnosticLocation} />
        </div>
      )}

      {/* HTML export outcome, on the same terms: a fatal failure, and — separately — the images that
          could not be retrieved. The second is not a failure: the file downloaded, but those pictures
          are missing from it, which the author can only know if we say so. */}
      {htmlExportError && (
        <div role="alert" className="shrink-0 border-b border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {`Export to HTML failed: ${htmlExportError}`}
        </div>
      )}
      {htmlExportFailures.length > 0 && (
        <div role="status" className="shrink-0 border-b px-3 py-2 text-sm text-muted-foreground">
          {`${htmlExportFailures.length} image${htmlExportFailures.length === 1 ? '' : 's'} could not be included in the exported HTML: ${htmlExportFailures
            .map((failure) => failure.source)
            .join(', ')}`}
        </div>
      )}
    </>
  );
}
