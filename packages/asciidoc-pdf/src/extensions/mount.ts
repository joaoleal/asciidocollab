/**
 * @file Turns a render request's extension selection into loadable code in the VM.
 *
 * The registry's `resolvePdfExtensions` decides what may load and in what order. This module writes
 * the cleared source into the VM and reports what the convert should require and enable.
 *
 * Loading an extension is no longer the same thing as enabling it, for the following reason.
 *
 * Extensions customise the converter by prepending a module, which Ruby cannot undo. The wasm VM is
 * warm and never torn down, so an extension required into it stays in the ancestor chain for every
 * later render in that session, whatever that project selected.
 *
 * This module used to answer that by DISCARDING the VM whenever the new selection was not a superset
 * of what was loaded (`needsFreshVm`). That was sound but expensive, and it only ever protected the
 * one caller that remembered to ask: the parity harness reuses one warm VM across every fixture and
 * did not, so extensions accumulated down the run and three fixtures failed purely on the order the
 * directory happened to be walked in.
 *
 * The prepend is now separated from the ACTIVATION. Each extension's hooks gate at runtime on the
 * per-render id set published by `invokeConvert`, so a module still sitting in the ancestor chain
 * from an earlier render simply declines to act. Accumulation becomes harmless, every caller is
 * protected without having to know the rule, and no VM is ever discarded to satisfy a selection —
 * which is what makes SC-015a (disable returns the unextended document) and FR-031b1 (preview
 * without one extension) hold for a warm VM rather than in spite of it.
 */

import { compareExtensionIds } from '@asciidocollab/asciidoc-core';
import { resolvePdfExtensions, type PdfExtensionResolution } from './registry';
import type { LoadedExtensionReference } from '../convert/invoke';
import type { RenderRequest } from '../protocol';

/** The VFS write surface mounting needs — the warm VM, narrowed to what is used here. */
export interface ExtensionMountPort {
  /**
   * Write bytes to an absolute VFS path.
   *
   * @param path - Absolute VFS path, always under a deployment-controlled extension mount.
   * @param bytes - The Ruby source, UTF-8 encoded.
   */
  writeFile: (path: string, bytes: Uint8Array) => void;
}

/** What a render's extensions resolved to, and what the caller must do about it. */
export interface MountedPdfExtensions {
  /**
   * The extensions to require and enable for this render, in load order — hand straight to
   * `invokeConvert`. Each carries both its VFS path and its id, because the convert has to publish
   * the id set alongside the requires (see `ENABLED_EXTENSIONS_GLOBAL`).
   */
  readonly loadedExtensions: readonly LoadedExtensionReference[];
  /** Extensions asked for that will not load, each with a reason for the author or administrator. */
  readonly rejected: PdfExtensionResolution['rejected'];
}

/** The ids a request asks for, de-duplicated and ordered so two spellings of one set compare equal. */
export function requestedExtensionIds(request: RenderRequest): readonly string[] {
  const ids = request.snapshot.enabledExtensions;
  if (ids === undefined) return [];
  return [...new Set(ids)].toSorted((a, b) => compareExtensionIds(a, b));
}

/** A render that selected nothing: no requires, nothing enabled, nothing refused. */
const NOTHING_MOUNTED: MountedPdfExtensions = { loadedExtensions: [], rejected: [] };

/**
 * Resolve a request's extensions and write their source into the VM.
 *
 * Writing an already-written path again is harmless and is not special-cased: the bytes are
 * identical, and `require` — which the convert uses rather than `load` — is what makes a repeat
 * mention of an already-loaded file a no-op.
 *
 * Nothing here is stateful across renders any more. The result describes THIS request's selection
 * only, and the convert publishes it as the enabled set, so what an earlier render happened to load
 * into the same VM cannot affect this one.
 *
 * @param port - The VM's VFS write surface.
 * @param request - The render request, carrying both the selection and the code to satisfy it.
 * @returns What to require and enable, and anything refused.
 */
export function mountPdfExtensions(
  port: ExtensionMountPort,
  request: RenderRequest,
): MountedPdfExtensions {
  const requested = requestedExtensionIds(request);
  if (requested.length === 0) {
    return NOTHING_MOUNTED;
  }

  const bundle = request.extensions;
  if (bundle === undefined) {
    // Asking for extensions with nothing to load them FROM is a wiring fault, not an author's
    // mistake. Reported per id rather than thrown, so the render still produces a document and the
    // reason reaches the caller as a diagnostic.
    return {
      loadedExtensions: [],
      rejected: requested.map((id) => ({
        id,
        reason: 'No extension code was supplied with this render request.',
      })),
    };
  }

  const resolution = resolvePdfExtensions(requested, bundle.catalogue, bundle.sources);
  const encoder = new TextEncoder();
  for (const extension of resolution.loaded) {
    port.writeFile(extension.vfsPath, encoder.encode(extension.source));
  }

  return {
    loadedExtensions: resolution.loaded.map(({ id, vfsPath }) => ({ id, vfsPath })),
    rejected: resolution.rejected,
  };
}
