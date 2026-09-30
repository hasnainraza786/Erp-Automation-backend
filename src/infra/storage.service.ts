import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Injectable, Logger } from '@nestjs/common';
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { env } from '../config/env';

/** Local disk in development; any S3-compatible store (Cloudflare R2, MinIO) in production. */
@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name);
  private readonly s3?: S3Client;
  private readonly root = resolve(env.STORAGE_LOCAL_DIR);

  constructor() {
    if (env.STORAGE_DRIVER === 's3') {
      this.s3 = new S3Client({
        region: env.S3_REGION,
        endpoint: env.S3_ENDPOINT,
        forcePathStyle: true,
        credentials: {
          accessKeyId: env.S3_ACCESS_KEY_ID ?? '',
          secretAccessKey: env.S3_SECRET_ACCESS_KEY ?? '',
        },
      });
      this.logger.log(`Using S3 storage bucket ${env.S3_BUCKET}`);
    }
  }

  async put(key: string, body: Buffer, contentType: string) {
    if (this.s3) {
      await this.s3.send(new PutObjectCommand({ Bucket: env.S3_BUCKET, Key: key, Body: body, ContentType: contentType }));
      return;
    }
    const path = this.localPath(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, body);
  }

  async get(key: string): Promise<Readable> {
    if (this.s3) {
      const res = await this.s3.send(new GetObjectCommand({ Bucket: env.S3_BUCKET, Key: key }));
      return res.Body as Readable;
    }
    const path = this.localPath(key);
    if (!existsSync(path)) throw new Error('File not found');
    return createReadStream(path);
  }

  /** Returns a short-lived direct URL when the driver supports it. */
  async signedUrl(key: string, expiresIn = 300): Promise<string | null> {
    if (!this.s3) return null;
    return getSignedUrl(this.s3, new GetObjectCommand({ Bucket: env.S3_BUCKET, Key: key }), { expiresIn });
  }

  private localPath(key: string) {
    const path = resolve(join(this.root, key));
    if (!path.startsWith(this.root)) throw new Error('Invalid storage key');
    return path;
  }
}
