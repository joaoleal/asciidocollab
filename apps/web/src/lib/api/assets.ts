import { API_BASE_URL } from './base-url';

/** Metadata returned after successfully uploading a file asset. */
export interface AssetMetadata {
  /** Unique identifier for the stored asset. */
  assetId: string;
  /** Original filename of the uploaded file. */
  filename: string;
  /** Server-side storage path of the asset. */
  storagePath: string;
  /** Size of the file in bytes. */
  sizeBytes: number;
  /** MIME type of the uploaded file. */
  mimeType: string;
}

/** Uploads a file asset to a project folder via multipart POST. */
export async function uploadAsset(projectId: string, parentId: string, file: File): Promise<AssetMetadata> {
  const formData = new FormData();
  formData.append('file', file);

  const response = await fetch(
    `${API_BASE_URL}/projects/${projectId}/assets?parentId=${encodeURIComponent(parentId)}`,
    {
      method: 'POST',
      credentials: 'include',
      body: formData,
    },
  );

  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    const error: Error & { status?: number; code?: string } = new Error(body?.error?.message ?? `Upload failed: ${response.status}`);
    error.status = response.status;
    error.code = body?.error?.code ?? 'UPLOAD_ERROR';
    throw error;
  }

  const data = await response.json();
  return {
    assetId: data.assetId,
    filename: file.name,
    storagePath: data.storagePath,
    sizeBytes: file.size,
    mimeType: file.type,
  };
}
