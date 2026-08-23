import { Asset } from '../../entities/asset';
import { FileNodeId } from '../../value-objects/ids/file-node-id';

/**
 * Repository interface for managing Asset persistence.
 *
 * Asset.id is a foreign key to FileNode.id (1:1). Uniqueness of the
 * storage path within a project is guaranteed by the FileNode path
 * uniqueness constraint — the Asset layer does not duplicate projectId
 * or storagePath.
 */
export interface AssetRepository {
  /**
   * Finds an asset by its FileNode id.
   *
   * @param id - The FileNode id that owns the asset.
   * @returns The asset if found, null otherwise.
   */
  findById(id: FileNodeId): Promise<Asset | null>;

  /**
   * Finds every asset belonging to the given FileNode ids.
   *
   * Exists for the callers that walk a whole tree: asking one id at a time turns
   * a copy or an export of a project full of images into one round trip per
   * image, in sequence, inside a single request.
   *
   * @param ids - The FileNode ids whose assets are wanted.
   * @returns The assets that exist, in no guaranteed order; ids with no asset are absent.
   */
  findByIds(ids: readonly FileNodeId[]): Promise<Asset[]>;

  /**
   * Persists an asset entity.
   *
   * @param asset - The asset entity to save.
   * @returns Resolves when the save completes.
   * @throws {Error} If an asset with the same id already exists (1:1 FK constraint).
   */
  save(asset: Asset): Promise<void>;

  /**
   * Removes an asset by its FileNode id.
   *
   * @param id - The FileNode id of the asset to delete.
   * @returns Resolves when the deletion completes.
   */
  delete(id: FileNodeId): Promise<void>;
}
