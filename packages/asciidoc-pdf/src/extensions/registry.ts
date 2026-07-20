/**
 * @file Which converter extensions a render loads, and from where.
 *
 * The registry answers one question — *given a project's selection of extension ids, what Ruby
 * source should the convert require, in what order* — and the way it answers is the feature's
 * security boundary.
 *
 * **Project content is never executable.** A project's file tree is mounted at `/project`, and every
 * member with write access controls its contents. The VM exposes `JS.global`, so Ruby loaded into it
 * can reach the host page. Therefore an extension's code may come from exactly two places: the
 * shipped gem, or the administrator's drop folder — both outside `/project`, both under the
 * deployment's control. A candidate resolving under the project mount is REFUSED, not sanitised
 * (FR-034, FR-035, SC-012).
 *
 * The contract comes from `@asciidocollab/asciidoc-core`, not `@asciidocollab/shared`: this package
 * is bundled into a Web Worker and must not drag the domain ring in for a handful of interfaces.
 * `shared` re-exports the same declarations alongside the manifest validation.
 *
 * **This package never reads the drop folder itself.** It has no filesystem access and must not
 * import from `apps/*` (P0 blocking rule 9), so administrator-provided sources are INJECTED by the
 * web layer at the worker composition root. The registry's job is to validate and order what it is
 * given, not to go looking.
 *
 * **Order is by id, always.** Two extensions touching the same converter hook produce different
 * output depending on which loads first, so load order must not depend on the order an author
 * selected them or an administrator's filesystem enumerated them (FR-031c, Principle XII).
 */

import {
  orderPdfExtensions,
  compareExtensionIds,
  type PdfExtensionCatalogueEntry,
  type PdfExtensionOrigin,
} from '@asciidocollab/asciidoc-core';

/**
 * The VFS mount the project's own files live at. Nothing under this path may ever be loaded as code
 * — it is member-writable by definition.
 */
export const PROJECT_MOUNT_PREFIX = '/project';

/** The mount the shipped extension gem is baked into. Read-only, part of the application image. */
export const SHIPPED_EXTENSIONS_MOUNT = '/extensions/shipped';

/** The mount administrator-provided sources are written to before the convert runs. */
export const ADMINISTRATOR_EXTENSIONS_MOUNT = '/extensions/admin';

/** An extension's loadable Ruby source, as supplied to the registry. */
export interface PdfExtensionSource {
  /** The catalogue id this source implements. */
  readonly id: string;
  /** Where the code came from. */
  readonly origin: PdfExtensionOrigin;
  /** The Ruby source text. Mounted into the VFS and `require`d; never eval'd inline. */
  readonly source: string;
}

/** One extension resolved for loading: its id, its VFS path, and the source to write there. */
export interface ResolvedPdfExtension {
  /** The catalogue id this resolution is for. */
  readonly id: string;
  /** Where the code came from, which decides the mount it is written to. */
  readonly origin: PdfExtensionOrigin;
  /** Absolute VFS path the source is mounted at, always outside the project mount. */
  readonly vfsPath: string;
  /** The Ruby source to write at {@link ResolvedPdfExtension.vfsPath}. */
  readonly source: string;
}

/** An extension that was asked for but will not be loaded, and why. */
export interface RejectedPdfExtension {
  /** The id that was asked for but will not be loaded. */
  readonly id: string;
  /** Why it will not be loaded, in terms an author or administrator can act on. */
  readonly reason: string;
}

/** The registry's decision about a project's selection. */
export interface PdfExtensionResolution {
  /** What will be loaded, in load order. */
  readonly loaded: readonly ResolvedPdfExtension[];
  /** What will not, with a reason for each. Never silently dropped. */
  readonly rejected: readonly RejectedPdfExtension[];
}

/** The mount an origin's code is written to. */
function mountFor(origin: PdfExtensionOrigin): string {
  return origin === 'shipped' ? SHIPPED_EXTENSIONS_MOUNT : ADMINISTRATOR_EXTENSIONS_MOUNT;
}

/**
 * Whether a resolved VFS path is one this loader may execute.
 *
 * Exported so {@link resolvePdfExtensions} and the test that guards this boundary assert the SAME
 * rule. If anyone later widens the loader's search path, the test fails rather than the widening
 * going unnoticed.
 *
 * @param vfsPath - The absolute VFS path a candidate would be loaded from.
 * @returns True only for a path under a deployment-controlled mount.
 */
export function isLoadableExtensionPath(vfsPath: string): boolean {
  // Normalised comparison: a path containing `..` could resolve under `/project` while textually
  // starting elsewhere, so anything with a traversal segment is refused outright rather than
  // resolved. Refusing is safe; resolving is a judgement call this boundary should not be making.
  if (vfsPath.includes('..')) return false;
  if (!vfsPath.startsWith('/')) return false;
  if (vfsPath.startsWith(`${PROJECT_MOUNT_PREFIX}/`) || vfsPath === PROJECT_MOUNT_PREFIX) return false;
  return (
    vfsPath.startsWith(`${SHIPPED_EXTENSIONS_MOUNT}/`) ||
    vfsPath.startsWith(`${ADMINISTRATOR_EXTENSIONS_MOUNT}/`)
  );
}

/**
 * Decide which of a project's enabled extensions to load, and in what order.
 *
 * @param enabledIds - The ids the project has enabled, in whatever order they were stored.
 * @param catalogue - Every entry currently on offer, for checking availability.
 * @param sources - The Ruby source for each id, injected by the composition root.
 * @returns What will load, in id order, and what was refused with a reason.
 */
export function resolvePdfExtensions(
  enabledIds: readonly string[],
  catalogue: readonly PdfExtensionCatalogueEntry[],
  sources: readonly PdfExtensionSource[],
): PdfExtensionResolution {
  const byId = new Map(catalogue.map((entry) => [entry.manifest.id, entry]));
  const sourceById = new Map(sources.map((source) => [source.id, source]));

  const loaded: ResolvedPdfExtension[] = [];
  const rejected: RejectedPdfExtension[] = [];

  // De-duplicated so a selection listing an id twice cannot load it twice — an extension that
  // `prepend`s a module is not idempotent under a double load (contract C3).
  for (const id of new Set(enabledIds)) {
    const entry = byId.get(id);
    if (entry === undefined) {
      rejected.push({ id, reason: 'No catalogue entry offers this extension.' });
      continue;
    }
    if (!entry.available) {
      rejected.push({ id, reason: 'This extension is no longer available in this deployment.' });
      continue;
    }
    const source = sourceById.get(id);
    if (source === undefined) {
      rejected.push({ id, reason: 'No source was supplied for this extension.' });
      continue;
    }
    if (source.origin !== entry.origin) {
      // A source claiming a different origin than the catalogue records is a mismatch between what
      // was offered and what turned up. Refuse rather than pick one to believe.
      rejected.push({ id, reason: 'The supplied source does not match the catalogue entry’s origin.' });
      continue;
    }

    const vfsPath = `${mountFor(source.origin)}/${id}.rb`;
    if (!isLoadableExtensionPath(vfsPath)) {
      rejected.push({ id, reason: 'Refused: extension code may only be loaded from a deployment-controlled path.' });
      continue;
    }

    loaded.push({ id, origin: source.origin, vfsPath, source: source.source });
  }

  // Ordered by id via the shared comparator, so the renderer and the catalogue agree on load order.
  const order = orderPdfExtensions(
    loaded.map((extension) => byId.get(extension.id)).filter((entry): entry is PdfExtensionCatalogueEntry => entry !== undefined),
  ).map((entry) => entry.manifest.id);
  const ordered = order
    .map((id) => loaded.find((extension) => extension.id === id))
    .filter((extension): extension is ResolvedPdfExtension => extension !== undefined);

  return {
    loaded: ordered,
    rejected: rejected.toSorted((a, b) => compareExtensionIds(a.id, b.id)),
  };
}
