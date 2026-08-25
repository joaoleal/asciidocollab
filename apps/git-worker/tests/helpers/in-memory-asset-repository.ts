import type { Asset, AssetRepository, FileNodeId } from '@asciidocollab/domain';

/**
 * A local, minimal in-memory `AssetRepository` fake for this app's tests. See
 * `in-memory-git-operation-repository.ts`'s class docs for why this app keeps its own fakes
 * rather than reusing `packages/domain/tests`'.
 */
export class InMemoryAssetRepository implements AssetRepository {
  private readonly storage = new Map<string, Asset>();

  async findById(id: FileNodeId): Promise<Asset | null> {
    return this.storage.get(id.value) ?? null;
  }

  async findByIds(ids: readonly FileNodeId[]): Promise<Asset[]> {
    const found: Asset[] = [];
    for (const id of ids) {
      const asset = this.storage.get(id.value);
      if (asset !== undefined) found.push(asset);
    }
    return found;
  }

  async save(asset: Asset): Promise<void> {
    if (this.storage.has(asset.id.value)) {
      throw new Error(`Asset for FileNode ${asset.id.value} already exists`);
    }
    this.storage.set(asset.id.value, asset);
  }

  async delete(id: FileNodeId): Promise<void> {
    this.storage.delete(id.value);
  }
}
