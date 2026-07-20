import { GetPdfExtensionCatalogueUseCase } from '../../../src/use-cases/project/get-pdf-extension-catalogue';
import { InMemoryPdfExtensionSource } from '../../ports/pdf-extensions/in-memory-pdf-extension-source';
import { InMemoryProjectMemberRepository } from '../../ports/project/in-memory-project-member.repository';
import { ProjectMember } from '../../../src/entities/project-member';
import { ProjectId } from '../../../src/value-objects/ids/project-id';
import { UserId } from '../../../src/value-objects/ids/user-id';
import { Role } from '../../../src/value-objects/identity/role';
import { PermissionDeniedError } from '../../../src/errors/common/permission-denied';
import { ValidationError } from '../../../src/errors/common/validation-error';
import type { PdfExtensionManifest } from '@asciidocollab/asciidoc-core';

const projectId = ProjectId.create('770e8400-e29b-41d4-a716-446655440003');
const memberId = UserId.create('550e8400-e29b-41d4-a716-446655440001');
const outsiderId = UserId.create('550e8400-e29b-41d4-a716-446655440009');

/** A manifest for `id`. */
function manifest(id: string): PdfExtensionManifest {
  return {
    id,
    displayName: id,
    description: `The ${id} extension.`,
    targeting: '',
    themeKeys: [],
    sampleContent: '',
  };
}

let members: InMemoryProjectMemberRepository;
let administrator: InMemoryPdfExtensionSource;

/** Build the use case over the current fakes. */
function useCase(shipped: PdfExtensionManifest[] = [manifest('paragraph-numbering')]) {
  return new GetPdfExtensionCatalogueUseCase(members, shipped, administrator);
}

/** Run it as the member, expecting success. */
async function catalogue(enabledIds: string[] = [], shipped?: PdfExtensionManifest[]) {
  const result = await useCase(shipped).execute({ actorId: memberId, projectId, enabledIds });
  if (!result.success) throw new Error('expected success');
  return result.value;
}

beforeEach(async () => {
  members = new InMemoryProjectMemberRepository();
  administrator = new InMemoryPdfExtensionSource();
  await members.addMember(new ProjectMember(projectId, memberId, Role.create('editor')));
});

describe('GetPdfExtensionCatalogueUseCase — authorization lives here', () => {
  it('refuses a non-member', async () => {
    // Enforced in the use case, not the route: it is the one place every caller passes through, so a
    // future caller cannot forget it and leak another project's administrator configuration.
    const result = await useCase().execute({ actorId: outsiderId, projectId, enabledIds: [] });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBeInstanceOf(PermissionDeniedError);
  });

  it('serves any member, not just owners', async () => {
    const result = await useCase().execute({ actorId: memberId, projectId, enabledIds: [] });
    expect(result.success).toBe(true);
  });
});

describe('GetPdfExtensionCatalogueUseCase — merging the two sources', () => {
  it('offers the shipped extensions', async () => {
    const result = await catalogue();
    expect(result.entries.map((entry) => entry.manifest.id)).toEqual(['paragraph-numbering']);
    expect(result.entries[0].origin).toBe('shipped');
  });

  it('merges administrator entries alongside them', async () => {
    administrator.add(manifest('house-style'));
    const result = await catalogue();
    expect(result.entries.map((entry) => entry.manifest.id)).toEqual(['house-style', 'paragraph-numbering']);
    expect(result.entries.find((entry) => entry.manifest.id === 'house-style')?.origin).toBe(
      'administrator-provided',
    );
  });

  it('orders the merged catalogue by id, not by source', async () => {
    // Load order follows catalogue order, so it must not depend on which source an entry came from.
    administrator.add(manifest('alpha'));
    const result = await catalogue([], [manifest('zebra')]);
    expect(result.entries.map((entry) => entry.manifest.id)).toEqual(['alpha', 'zebra']);
  });
});

describe('GetPdfExtensionCatalogueUseCase — a duplicate id is a conflict (FR-033e)', () => {
  it('keeps the shipped entry and reports the conflict', async () => {
    // The administrator's folder is editable outside the release process, so letting it silently
    // replace a shipped extension would let a deployment's output change with no version change.
    administrator.add({ ...manifest('paragraph-numbering'), displayName: 'Impostor' });
    const result = await catalogue();
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].origin).toBe('shipped');
    expect(result.entries[0].manifest.displayName).toBe('paragraph-numbering');
    expect(result.conflicts).toEqual([
      expect.objectContaining({ id: 'paragraph-numbering' }),
    ]);
  });

  it('reports no conflict when the ids are distinct', async () => {
    administrator.add(manifest('house-style'));
    const result = await catalogue();
    expect(result.conflicts).toEqual([]);
  });
});

describe('GetPdfExtensionCatalogueUseCase — malformed entries are reported (FR-033d)', () => {
  it('passes the adapter’s exclusions through', async () => {
    administrator.exclude('broken', 'manifest.json is not valid JSON.');
    const result = await catalogue();
    expect(result.excluded).toEqual([
      { source: 'broken', reason: 'manifest.json is not valid JSON.' },
    ]);
  });

  it('still offers the good entries alongside the excluded ones', async () => {
    administrator.add(manifest('house-style')).exclude('broken', 'malformed');
    const result = await catalogue();
    expect(result.entries.map((entry) => entry.manifest.id)).toContain('house-style');
    expect(result.excluded).toHaveLength(1);
  });

  it('degrades to the shipped catalogue when the folder cannot be read', async () => {
    // A misconfigured mount must not make every project's options page unusable.
    administrator.failList(new ValidationError('EACCES'));
    const result = await catalogue();
    expect(result.entries.map((entry) => entry.manifest.id)).toEqual(['paragraph-numbering']);
    expect(result.excluded[0].reason).toMatch(/could not be read/i);
  });
});

describe('GetPdfExtensionCatalogueUseCase — stale selections (FR-030)', () => {
  it('reports an enabled id nothing offers any more', async () => {
    // An administrator can remove an extension a project still uses. The owner must be told rather
    // than have their output silently change.
    const result = await catalogue(['retired']);
    expect(result.staleSelections).toEqual(['retired']);
  });

  it('keeps the stale id in the catalogue, marked unavailable', async () => {
    // Kept so the UI can show the owner what their project still references, rather than the
    // selection quietly vanishing.
    const result = await catalogue(['retired']);
    const stale = result.entries.find((entry) => entry.manifest.id === 'retired');
    expect(stale?.available).toBe(false);
    expect(stale?.manifest.description).toMatch(/no longer available/i);
  });

  it('reports nothing stale when every selection is still offered', async () => {
    const result = await catalogue(['paragraph-numbering']);
    expect(result.staleSelections).toEqual([]);
  });

  it('reports an administrator extension that was removed', async () => {
    administrator.add(manifest('house-style'));
    const whileOffered = await catalogue(['house-style']);
    expect(whileOffered.staleSelections).toEqual([]);
    administrator.remove('house-style');
    const afterRemoval = await catalogue(['house-style']);
    expect(afterRemoval.staleSelections).toEqual(['house-style']);
  });

  it('reports a duplicated stale selection once', async () => {
    const result = await catalogue(['retired', 'retired']);
    expect(result.staleSelections).toEqual(['retired']);
  });

  it('reports stale selections in a stable order', async () => {
    const result = await catalogue(['zzz', 'aaa']);
    expect(result.staleSelections).toEqual(['aaa', 'zzz']);
  });
});
