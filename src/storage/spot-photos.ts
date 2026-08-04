import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import imageSize from 'image-size';
import { BlobServiceClient } from '@azure/storage-blob';
import { env } from '../config/env.js';

export interface SpotPhotoSaveResult {
  object_key: string;
  url: string;
  size_bytes: number;
  mime_type: string;
  width: number;
  height: number;
}

export interface SpotPhotoStorageProvider {
  readonly name: 'local' | 'azure';
  savePhoto(buffer: Buffer, mimeType: string, extension: string): Promise<SpotPhotoSaveResult>;
  deletePhoto(objectKey: string): Promise<void>;
}

export class LocalStorageProvider implements SpotPhotoStorageProvider {
  readonly name = 'local' as const;
  private uploadDir: string;

  constructor() {
    this.uploadDir = path.resolve(process.cwd(), env.LOCAL_UPLOAD_DIR || 'uploads/spot-photos');
    this.ensureUploadDir();
  }

  private ensureUploadDir(): string {
    const resolved = path.resolve(process.cwd(), env.LOCAL_UPLOAD_DIR || 'uploads/spot-photos');
    if (!fs.existsSync(resolved)) {
      fs.mkdirSync(resolved, { recursive: true });
    }
    return resolved;
  }

  getUploadDir(): string {
    return this.ensureUploadDir();
  }

  async savePhoto(buffer: Buffer, mimeType: string, extension: string): Promise<SpotPhotoSaveResult> {
    const dir = this.getUploadDir();
    const cleanExt = extension.replace(/^\.+/, '') || 'jpg';
    const objectKey = `spot_photo_${randomUUID()}.${cleanExt}`;
    const filePath = path.resolve(dir, objectKey);

    // Prevent path traversal
    if (!filePath.startsWith(dir)) {
      throw new Error('PATH_TRAVERSAL_ATTEMPT');
    }

    await fs.promises.writeFile(filePath, buffer);

    let width = 0;
    let height = 0;
    try {
      const dimensions = imageSize(buffer);
      width = dimensions.width || 0;
      height = dimensions.height || 0;
    } catch (e) {
      // Fallback 0 dimensions if header parsing fails
    }

    const url = `/api/v1/uploads/spot-photos/${objectKey}`;

    return {
      object_key: objectKey,
      url,
      size_bytes: buffer.length,
      mime_type: mimeType,
      width,
      height,
    };
  }

  async deletePhoto(objectKey: string): Promise<void> {
    const dir = this.getUploadDir();
    const filePath = path.resolve(dir, objectKey);

    if (!filePath.startsWith(dir)) {
      throw new Error('PATH_TRAVERSAL_ATTEMPT');
    }

    if (fs.existsSync(filePath)) {
      await fs.promises.unlink(filePath);
    }
  }
}

export class AzureBlobStorageProvider implements SpotPhotoStorageProvider {
  readonly name = 'azure' as const;
  private containerName: string;
  private connectionString: string;

  constructor() {
    if (!env.AZURE_STORAGE_CONNECTION_STRING) {
      throw new Error('STORAGE_CONFIG_ERROR: AZURE_STORAGE_CONNECTION_STRING is missing');
    }
    this.connectionString = env.AZURE_STORAGE_CONNECTION_STRING;
    this.containerName = env.AZURE_STORAGE_CONTAINER_NAME || 'spot-photos';
  }

  async savePhoto(buffer: Buffer, mimeType: string, extension: string): Promise<SpotPhotoSaveResult> {
    const blobServiceClient = BlobServiceClient.fromConnectionString(this.connectionString);
    const containerClient = blobServiceClient.getContainerClient(this.containerName);
    await containerClient.createIfNotExists({ access: 'blob' });

    const cleanExt = extension.replace(/^\.+/, '') || 'jpg';
    const objectKey = `spot_photo_${randomUUID()}.${cleanExt}`;
    const blockBlobClient = containerClient.getBlockBlobClient(objectKey);

    await blockBlobClient.uploadData(buffer, {
      blobHTTPHeaders: { blobContentType: mimeType },
    });

    let width = 0;
    let height = 0;
    try {
      const dimensions = imageSize(buffer);
      width = dimensions.width || 0;
      height = dimensions.height || 0;
    } catch (e) {
      // Fallback 0
    }

    return {
      object_key: objectKey,
      url: blockBlobClient.url,
      size_bytes: buffer.length,
      mime_type: mimeType,
      width,
      height,
    };
  }

  async deletePhoto(objectKey: string): Promise<void> {
    const blobServiceClient = BlobServiceClient.fromConnectionString(this.connectionString);
    const containerClient = blobServiceClient.getContainerClient(this.containerName);
    const blockBlobClient = containerClient.getBlockBlobClient(objectKey);
    await blockBlobClient.deleteIfExists();
  }
}

export function getSpotPhotoStorageProvider(): SpotPhotoStorageProvider {
  if (env.SPOT_PHOTO_STORAGE === 'azure') {
    return new AzureBlobStorageProvider();
  }
  return new LocalStorageProvider();
}
