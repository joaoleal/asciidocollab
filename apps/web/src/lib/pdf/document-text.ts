import type { ProjectSnapshot } from '@asciidocollab/asciidoc-pdf';

/**
 * The document text the main-thread mermaid pre-pass scans: the render-root file's contents.
 *
 * Both the live preview and the one-click export render the project from the RENDER ROOT
 * (`snapshot.rootPath`) — the worker assembles includes starting there, regardless of which file is
 * open in the editor. So the pre-pass must scan the root file too, or a root-document mermaid diagram
 * would never be pre-rendered and would drop from the output. Shared by {@link usePdfPreview} and
 * {@link usePdfExport} so the two can never disagree on which file seeds the pre-pass.
 *
 * NOTE: this reads only the top-level root file text — includes are NOT resolved on the main thread.
 * A mermaid block inside an INCLUDED file is therefore not pre-seeded; the worker's DOM-less mermaid
 * shim cannot draw it and it degrades to a surfaced per-block render diagnostic (never silently). See
 * the pre-pass call sites for the rationale for keeping include assembly off the main thread.
 */
export function documentTextOf(snapshot: ProjectSnapshot): string {
  return snapshot.files[snapshot.rootPath] ?? '';
}
