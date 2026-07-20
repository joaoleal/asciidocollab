import { UserId } from '../../value-objects/ids/user-id';
import { ProjectId } from '../../value-objects/ids/project-id';
import { ProjectMemberRepository } from '../../ports/project/project-member.repository';
import { PermissionDeniedError } from '../../errors/common/permission-denied';
import { DomainError } from '../../errors/domain-error';
import { Result } from '../../types/result';
import { orderPdfExtensions, type PdfExtensionCatalogueEntry, type PdfExtensionManifest } from '@asciidocollab/asciidoc-core';
import type {
  ExcludedPdfExtension,
  PdfExtensionSourcePort,
} from '../../ports/pdf-extensions/pdf-extension-source.port';

/**
 * @file Assembles the PDF converter-extension catalogue a project may choose from.
 *
 * The assembly lives HERE, in the use case, and not in the route — because it is not a lookup. It
 * merges two sources with different trust levels, decides what a duplicate id means, resolves which
 * of a project's stored selections are still available, and enforces who may see any of it. A route
 * that did this would be delivery-layer code making product decisions, which is the violation the
 * architecture review found in the first draft of this feature.
 *
 * Authorization is enforced here for the same reason: it is the one place every caller of the
 * catalogue passes through. A route-level check would have to be repeated by every future caller,
 * and the first one to forget would leak another project's administrator configuration.
 */

/** A duplicate id between the shipped set and the administrator's folder. */
export interface PdfExtensionConflict {
  /** The contested id. */
  readonly id: string;
  /** What the conflict means for the catalogue. */
  readonly reason: string;
}

/** The catalogue as offered to one project. */
export interface PdfExtensionCatalogue {
  /** Every entry on offer, ordered by id. */
  readonly entries: readonly PdfExtensionCatalogueEntry[];
  /**
   * Ids the project has enabled that nothing offers any more.
   *
   * Surfaced rather than dropped: an administrator can remove an extension a project still uses, and
   * the owner must be told instead of having their output silently change (FR-030).
   */
  readonly staleSelections: readonly string[];
  /** Administrator entries excluded as malformed or oversized, with reasons (FR-033d). */
  readonly excluded: readonly ExcludedPdfExtension[];
  /** Duplicate ids between the two sources (FR-033e). */
  readonly conflicts: readonly PdfExtensionConflict[];
}

/** Inputs for {@link GetPdfExtensionCatalogueUseCase.execute}. */
export interface GetPdfExtensionCatalogueInput {
  /** The member asking. */
  readonly actorId: UserId;
  /** The project the catalogue is for. */
  readonly projectId: ProjectId;
  /** The ids this project currently has enabled, from its stored render config. */
  readonly enabledIds: readonly string[];
}

/** Assembles the extension catalogue for a project, merging shipped and administrator entries. */
export class GetPdfExtensionCatalogueUseCase {
  /**
   * Creates the use case.
   *
   * @param projectMemberRepo - Membership, for the authorization check.
   * @param shippedManifests - The manifests that ship with the application.
   * @param administratorSource - The only route to the administrator's drop folder.
   */
  constructor(
    private readonly projectMemberRepo: ProjectMemberRepository,
    private readonly shippedManifests: readonly PdfExtensionManifest[],
    private readonly administratorSource: PdfExtensionSourcePort,
  ) {}

  /**
   * Assemble the catalogue this project may choose from.
   *
   * @param input - The actor, the project, and the project's stored selection.
   * @returns The catalogue, or a permission error when the actor is not a member.
   */
  async execute(
    input: GetPdfExtensionCatalogueInput,
  ): Promise<Result<PdfExtensionCatalogue, DomainError>> {
    const membership = await this.projectMemberRepo.findByCompositeKey(input.projectId, input.actorId);
    if (membership === null) {
      return { success: false, error: new PermissionDeniedError() };
    }

    const entries: PdfExtensionCatalogueEntry[] = this.shippedManifests.map((manifest) => ({
      manifest,
      origin: 'shipped' as const,
      available: true,
    }));
    const byId = new Map(entries.map((entry) => [entry.manifest.id, entry]));
    const conflicts: PdfExtensionConflict[] = [];

    const listed = await this.administratorSource.list();
    // An unreadable folder yields no exclusions to report, not an empty catalogue: the shipped set
    // is still offered. See the failure branch below.
    let excluded: readonly ExcludedPdfExtension[] = listed.success ? listed.value.excluded : [];
    if (listed.success) {
      for (const discovered of listed.value.extensions) {
        const id = discovered.manifest.id;
        const existing = byId.get(id);
        if (existing !== undefined) {
          // The pre-existing entry WINS — the shipped one against an administrator's folder (that
          // folder is editable outside the release process, so letting it silently replace a shipped
          // extension would change a deployment's output without changing its version), and the
          // first-found one when two administrator folders offer the same id. The reason names the
          // winner's origin so the message is accurate in both cases; which entry wins is unchanged.
          conflicts.push({
            id,
            reason:
              existing.origin === 'shipped'
                ? 'An administrator-provided extension uses the id of a shipped one; the shipped extension is used.'
                : 'Two administrator-provided extensions use the same id; the first one found is used.',
          });
          continue;
        }
        const entry: PdfExtensionCatalogueEntry = {
          manifest: discovered.manifest,
          origin: 'administrator-provided',
          available: true,
        };
        entries.push(entry);
        byId.set(id, entry);
      }
    } else {
      // An unreadable folder degrades to the shipped catalogue rather than failing the request: a
      // misconfigured mount must not make every project's options page unusable.
      excluded = [
        {
          source: 'administrator extension folder',
          reason: 'The folder could not be read; only the extensions shipped with the application are offered.',
        },
      ];
    }

    // A stored id nothing offers is reported AND kept in the catalogue as unavailable, so the UI can
    // show the owner what their project still references.
    const staleSelections: string[] = [];
    for (const id of new Set(input.enabledIds)) {
      if (byId.has(id)) continue;
      staleSelections.push(id);
      entries.push({
        manifest: {
          id,
          displayName: id,
          description: 'This extension is no longer available in this deployment.',
          targeting: '',
          themeKeys: [],
          sampleContent: '',
        },
        origin: 'administrator-provided',
        available: false,
      });
    }

    return {
      success: true,
      value: {
        entries: orderPdfExtensions(entries),
        staleSelections: staleSelections.toSorted((a, b) => a.localeCompare(b)),
        excluded,
        conflicts: conflicts.toSorted((a, b) => a.id.localeCompare(b.id)),
      },
    };
  }
}
