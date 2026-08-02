import { GetKeyBindingsUseCase } from '../../../src/use-cases/settings/get-key-bindings';
import { DEFAULT_KEY_BINDINGS } from '../../../src/constants/key-bindings';
import { InMemoryKeyBindingRepository } from '../../ports/user/in-memory-key-binding.repository';

const userId = '550e8400-e29b-41d4-a716-446655440001';

describe('GetKeyBindingsUseCase', () => {
  let repo: InMemoryKeyBindingRepository;
  let useCase: GetKeyBindingsUseCase;

  beforeEach(() => {
    repo = new InMemoryKeyBindingRepository();
    useCase = new GetKeyBindingsUseCase(repo);
  });

  it('returns all actions merged with defaults when no DB rows exist', async () => {
    const result = await useCase.execute(userId);
    // Counted from the registry rather than written out. This use case exists to answer "every
    // shortcut, with the combo in force", so a shortcut added to the registry must appear — and an
    // assertion pinned to a literal fails on the addition itself, which says nothing about whether it
    // is being returned.
    expect(result.map((binding) => binding.action).toSorted()).toEqual(
      Object.keys(DEFAULT_KEY_BINDINGS).toSorted(),
    );
    expect(result.every((r) => r.isDefault)).toBe(true);
  });

  it('groups by namespace, so each surface can ask for only its own shortcuts', async () => {
    const editor = await useCase.execute(userId, 'editor');
    expect(editor.length).toBeGreaterThan(0);
    expect(editor.every((binding) => binding.action.startsWith('editor:'))).toBe(true);
  });

  it('each result includes the human-readable label from the definition', async () => {
    const result = await useCase.execute(userId);
    const findBinding = result.find((r) => r.action === 'file-tree:find');
    expect(findBinding?.label).toBe('Find File');
    const renameBinding = result.find((r) => r.action === 'file-tree:rename');
    expect(renameBinding?.label).toBe('Rename');
  });

  it('returns custom combo when DB row present', async () => {
    await repo.upsert(userId, 'file-tree:rename', 'F3');
    const result = await useCase.execute(userId);
    const binding = result.find((r) => r.action === 'file-tree:rename');
    expect(binding?.keyCombo).toBe('F3');
  });

  it('isDefault: false for customised binding', async () => {
    await repo.upsert(userId, 'file-tree:rename', 'F3');
    const result = await useCase.execute(userId);
    const binding = result.find((r) => r.action === 'file-tree:rename');
    expect(binding?.isDefault).toBe(false);
  });

  it('isDefault: true for default binding', async () => {
    const result = await useCase.execute(userId);
    const binding = result.find((r) => r.action === 'file-tree:delete');
    expect(binding?.isDefault).toBe(true);
  });

  it('optional namespace filter returns only matching actions', async () => {
    const result = await useCase.execute(userId, 'file-tree');
    expect(result.every((r) => r.action.startsWith('file-tree:'))).toBe(true);
    const fileTreeActions = Object.entries(DEFAULT_KEY_BINDINGS)
      .filter(([, definition]) => definition.namespace === 'file-tree')
      .map(([action]) => action);
    expect(result.map((binding) => binding.action).toSorted()).toEqual(fileTreeActions.toSorted());
  });
});
