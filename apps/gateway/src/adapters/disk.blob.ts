import * as fs from 'fs/promises';
import * as path from 'path';
import { BlobPort } from '../ports/ports';

/**
 * Disk blob adapter — implements the SAME presigned-URL choreography as S3:
 *   1. POST /media/presign  → { uploadUrl, publicUrl }
 *   2. client PUTs bytes to uploadUrl        (here: the gateway's own route;
 *      S3 mode: MinIO directly — the client code is identical either way)
 *   3. chat message carries publicUrl + mime only
 *
 * The "signature" is a random component in the key itself: an unguessable
 * upload path is the poor-man's presign, adequate for dev. The point being
 * taught survives: MEDIA BYTES NEVER TRANSIT THE WEBSOCKET, and the API
 * authorizes uploads without proxying them (in S3 mode).
 */
export class DiskBlob implements BlobPort {
  constructor(private mediaDir: string) {}

  async init(): Promise<void> {
    await fs.mkdir(this.mediaDir, { recursive: true });
  }

  async presignPut(key: string, _mime: string) {
    return {
      uploadUrl: `/media/blob/${key}`, // same-origin relative URL; client PUTs here
      headers: {},
    };
  }

  publicUrl(key: string): string {
    return `/media/blob/${key}`;
  }

  private safePath(key: string): string {
    // Path-traversal guard: resolve inside mediaDir or refuse.
    const p = path.resolve(this.mediaDir, key);
    if (!p.startsWith(path.resolve(this.mediaDir))) throw new Error('bad key');
    return p;
  }

  async saveLocal(key: string, data: Buffer): Promise<void> {
    await fs.writeFile(this.safePath(key), data);
  }

  async readLocal(key: string): Promise<Buffer | null> {
    try {
      return await fs.readFile(this.safePath(key));
    } catch {
      return null;
    }
  }
}
