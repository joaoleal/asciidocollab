import { PrismaClient } from '@prisma/client';
import { Asset, FileNodeId, MimeType, AssetRepository } from '@asciidocollab/domain';

/**
 * Prisma-backed implementation of the `AssetRepository` interface.
 * Asset.id is a FK to FileNode.id (1:1). ProjectId, filename, and path
 * are on the associated FileNode and are not duplicated here.
 */
export class PrismaAssetRepository implements AssetRepository {
  /** Creates a new PrismaAssetRepository. */
  constructor(private readonly prisma: PrismaClient) {}

  /** Finds an asset by its FileNode id. */
  async findById(id: FileNodeId): Promise<Asset | null> {
    const record = await this.prisma.asset.findUnique({ where: { id: id.value } });
    return record ? toDomainAsset(record) : null;
  }

  /** Finds every asset belonging to the given FileNode ids, in one query. */
  async findByIds(ids: readonly FileNodeId[]): Promise<Asset[]> {
    if (ids.length === 0) return [];
    const records = await this.prisma.asset.findMany({
      where: { id: { in: ids.map((id) => id.value) } },
    });
    return records.map(toDomainAsset);
  }

  /** Persists an asset entity via upsert. */
  async save(asset: Asset): Promise<void> {
    await this.prisma.asset.upsert({
      where: { id: asset.id.value },
      create: toPersistenceAsset(asset),
      update: toPersistenceAsset(asset),
    });
  }

  /** Removes an asset by its FileNode id. */
  async delete(id: FileNodeId): Promise<void> {
    await this.prisma.asset.deleteMany({ where: { id: id.value } });
  }
}

type AssetRecord = {
  id: string;
  mimeType: string;
  sizeBytes: bigint;
  uploadedAt: Date;
  updatedAt: Date | null;
};

function toDomainAsset(record: AssetRecord): Asset {
  return new Asset(
    FileNodeId.create(record.id),
    MimeType.create(record.mimeType),
    record.sizeBytes,
    record.uploadedAt,
    record.updatedAt,
  );
}

function toPersistenceAsset(asset: Asset): AssetRecord {
  return {
    id: asset.id.value,
    mimeType: asset.mimeType.value,
    sizeBytes: asset.sizeBytes,
    uploadedAt: asset.uploadedAt,
    updatedAt: asset.updatedAt,
  };
}
