/**
 * Editor→PDF scroll-sync coordinate bridge. The engine's block source map is keyed to the ASSEMBLED
 * (include-expanded) document the worker converts, but the editor's cursor line is in the OPEN file.
 * These pure helpers translate an open-file line into its assembled-document line so the preview panel
 * can scroll to the exact rendered block. They are extracted from the editor layout so the branchy
 * translation is unit-testable in isolation (the layout only wires them to its live state).
 */

import { assembleIncludes, type SourceMapEntry } from '@/workers/assemble-includes';
import { blockStartLine } from '@/lib/asciidoc/block-start-line';
import type { ProjectSnapshot, PdfSourceMap } from '@asciidocollab/asciidoc-pdf';

/** The assembled-line→source provenance map: entry `i` gives the origin of assembled line `i + 1`. */
export type AssembledLineToSource = readonly SourceMapEntry[];

/**
 * The assembled document, plus the provenance and text a scroll-sync lookup needs: the line→source map
 * (to translate an open-file line into the assembled coordinate the engine map is keyed in) and the
 * assembled source split into lines (to lift each engine map entry to its block's visual start).
 */
export interface AssembledScrollContext {
  /** The assembled-line→source provenance map. */
  readonly lineToSource: AssembledLineToSource;
  /** The assembled document split into lines (0-based array of 1-based source lines). */
  readonly assembledLines: readonly string[];
}

/**
 * Assemble a snapshot's render root the SAME way the PDF pipeline's include-resolve stage does (root path
 * + seeded attributes, requesting the provenance map) and return the provenance map together with the
 * assembled source lines. Returns null when the assembler produced no provenance map.
 *
 * @param snapshot - The render snapshot whose root document is assembled.
 * @returns The provenance map and assembled source lines, or null when unavailable.
 */
export function buildAssembledScrollContext(snapshot: ProjectSnapshot): AssembledScrollContext | null {
  const assembled = assembleIncludes(
    snapshot.rootPath,
    (path: string) => snapshot.files[path] ?? null,
    { seedAttributes: new Map(Object.entries(snapshot.attributes)), withSourceMap: true },
  );
  const lineToSource = assembled.sourceMap?.lineToSource;
  if (lineToSource === undefined) return null;
  return { lineToSource, assembledLines: assembled.content.split('\n') };
}

/**
 * Build the assembled-document line→source-file provenance map for a snapshot's render root. Returns null
 * when the assembler produced no map.
 *
 * @param snapshot - The render snapshot whose root document is assembled.
 * @returns The assembled-line→source provenance map, or null when unavailable.
 */
export function buildAssembledLineToSource(snapshot: ProjectSnapshot): AssembledLineToSource | null {
  return buildAssembledScrollContext(snapshot)?.lineToSource ?? null;
}

/**
 * Whether a target file is part of the include tree rooted at `rootPath`: it IS the root, or the
 * assembled document (include-expanded from the root) contains at least one line originating in it. Used
 * to decide whether the open file belongs to the configured main document — if it does not, the preview
 * renders it on its own instead of showing the unrelated main document. Mirrors the outline's reachability
 * check (assemble from the root, look for the target path in the provenance map) so the two agree.
 *
 * @param rootPath - The project-relative path of the render root (the configured main document).
 * @param readFile - Reads a project file's content by path, or null when unavailable.
 * @param targetPath - The project-relative path to test for membership.
 * @returns True when the target belongs to the root's include tree.
 */
export function isPathInAssembledTree(
  rootPath: string,
  readFile: (path: string) => string | null,
  targetPath: string,
): boolean {
  if (targetPath === rootPath) return true;
  const assembled = assembleIncludes(rootPath, readFile, { withSourceMap: true });
  const lineToSource = assembled.sourceMap?.lineToSource;
  return lineToSource !== undefined && lineToSource.some((entry) => entry.path === targetPath);
}

/**
 * Lift each engine source-map entry's line to its block's VISUAL start (the block title/attribute lines
 * above its delimiter), so a click on a block's title line resolves to that block instead of the previous
 * one — the PDF-side twin of the HTML preview's `data-source-line` adjustment. Page/vertical positions are
 * preserved (the block still renders where it renders); only the key line moves up. The result is
 * re-sorted by line and de-duplicated (first entry per line wins) so the panel's binary search stays
 * valid. Returns the input unchanged when it is empty.
 *
 * @param sourceMap - The engine-emitted, line-sorted source map (assembled-document coordinates).
 * @param assembledLines - The assembled document split into lines (same coordinates as the map).
 * @returns A new source map keyed on each block's visual start line.
 */
export function liftSourceMapToBlockStarts(
  sourceMap: PdfSourceMap,
  assembledLines: readonly string[],
): PdfSourceMap {
  if (sourceMap.length === 0) return sourceMap;
  const lifted = sourceMap.map((entry) => ({
    ...entry,
    line: blockStartLine(assembledLines, entry.line),
  }));
  lifted.sort((a, b) => a.line - b.line);
  const deduped: typeof lifted = [];
  let lastLine: number | undefined;
  for (const entry of lifted) {
    if (entry.line !== lastLine) {
      deduped.push(entry);
      lastLine = entry.line;
    }
  }
  return deduped;
}

/**
 * Translate an open-file line into the assembled-document line the engine source map is keyed in: the
 * assembled line whose provenance is the GREATEST source line at or before the target within the open
 * file (so a blank or filtered target line still resolves to the nearest preceding mapped line, and
 * entries from other files are ignored). Returns undefined when the open file contributes no assembled
 * line at or before the target.
 *
 * @param lineToSource - The assembled-line→source provenance map.
 * @param openPath - The project-relative path of the open file the target line belongs to.
 * @param openLine - The 1-based line within the open file to translate.
 * @returns The 1-based assembled-document line, or undefined when none maps.
 */
export function openLineToAssembledLine(
  lineToSource: AssembledLineToSource,
  openPath: string,
  openLine: number,
): number | undefined {
  let bestAssembledLine: number | undefined;
  let bestSourceLine = -1;
  for (const [index, entry] of lineToSource.entries()) {
    if (entry.path === openPath && entry.sourceLine <= openLine && entry.sourceLine > bestSourceLine) {
      bestSourceLine = entry.sourceLine;
      bestAssembledLine = index + 1;
    }
  }
  return bestAssembledLine;
}
