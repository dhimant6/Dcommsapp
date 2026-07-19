import { BlobPort } from '../ports/ports';

/**
 * S3/MinIO blob adapter — the external-mode implementation.
 *
 * The AWS SDK is a ~25 MB dependency used only in external mode, so it is
 * lazy-required here rather than imported at the top: embedded-mode installs
 * and CI stay lean. To activate:
 *
 *   npm i @aws-sdk/client-s3 @aws-sdk/s3-request-presigner -w apps/gateway
 *   ADAPTERS=external + S3_* env vars (see .env.example)
 *
 * The presign is a time-limited signature (5 min) over ONE exact operation
 * (PUT this key with this content-type) — the API authorizes, the storage
 * tier carries the bytes. Same division of labor as LiveKit tokens.
 */
export class S3Blob implements BlobPort {
  private client: any;
  private presigner: any;
  private bucket!: string;
  private endpoint!: string;

  async init(opts: { endpoint: string; bucket: string; accessKey: string; secretKey: string }): Promise<void> {
    let clientMod: any, presignMod: any;
    try {
      clientMod = require('@aws-sdk/client-s3');
      presignMod = require('@aws-sdk/s3-request-presigner');
    } catch {
      throw new Error(
        'S3 adapter needs the AWS SDK: npm i @aws-sdk/client-s3 @aws-sdk/s3-request-presigner -w apps/gateway',
      );
    }
    this.bucket = opts.bucket;
    this.endpoint = opts.endpoint;
    this.client = new clientMod.S3Client({
      endpoint: opts.endpoint,
      region: 'us-east-1', // MinIO ignores region but the SDK requires one
      forcePathStyle: true, // MinIO uses path-style URLs (no bucket subdomains)
      credentials: { accessKeyId: opts.accessKey, secretAccessKey: opts.secretKey },
    });
    this.presigner = presignMod;
    this.clientMod = clientMod;
  }
  private clientMod: any;

  async presignPut(key: string, mime: string) {
    const cmd = new this.clientMod.PutObjectCommand({ Bucket: this.bucket, Key: key, ContentType: mime });
    const uploadUrl = await this.presigner.getSignedUrl(this.client, cmd, { expiresIn: 300 });
    return { uploadUrl, headers: { 'Content-Type': mime } };
  }

  publicUrl(key: string): string {
    // Bucket has anonymous read (compose minio-init). Production would presign
    // GETs too or front with a CDN — noted in "What I Didn't Build".
    return `${this.endpoint}/${this.bucket}/${key}`;
  }
}
