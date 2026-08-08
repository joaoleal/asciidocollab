import { applyRename } from '@/lib/codemirror/rename-suggestion/apply-rename';
import type { RenameSymbolResult } from '@/lib/api/projects';

const ok = (rewrittenFiles: number, updatedReferences: number, warnings: string[] = []): RenameSymbolResult => ({
  rewrittenFiles,
  updatedReferences,
  warnings,
});

describe('applyRename', () => {
  test('renames old→new and maps the result', async () => {
    const renameSymbol = jest.fn(async () => ok(3, 7, ['x.adoc: skipped']));
    const { result } = await applyRename({
      projectId: 'p1',
      symbolKind: 'attribute',
      renamedDefinitionIsSection: false,
      oldName: 'edition',
      newName: 'release',
      renameSymbol,
    });
    expect(renameSymbol).toHaveBeenCalledWith('p1', {
      symbolKind: 'attribute',
      oldName: 'edition',
      newName: 'release',
      definitionAlreadyRenamed: true,
      renamedDefinitionIsSection: false,
    });
    expect(result).toEqual({ rewrittenReferences: 7, rewrittenFiles: 3, warnings: ['x.adoc: skipped'] });
  });

  test('undo re-runs the rename in the opposite direction (new→old)', async () => {
    const renameSymbol = jest.fn(async () => ok(3, 7));
    const { undo } = await applyRename({
      projectId: 'p1',
      symbolKind: 'anchor',
      renamedDefinitionIsSection: false,
      oldName: 'intro',
      newName: 'overview',
      renameSymbol,
    });
    await undo();
    expect(renameSymbol).toHaveBeenNthCalledWith(1, 'p1', {
      symbolKind: 'anchor',
      oldName: 'intro',
      newName: 'overview',
      definitionAlreadyRenamed: true,
      renamedDefinitionIsSection: false,
    });
    expect(renameSymbol).toHaveBeenNthCalledWith(2, 'p1', { symbolKind: 'anchor', oldName: 'overview', newName: 'intro' });
  });
});
