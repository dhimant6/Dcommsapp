import { Global, Module } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { config } from '../config';
import { DB, KV, BLOB, DbPort, KvPort, BlobPort } from '../ports/ports';
import { PgliteDb } from './pglite.db';
import { PgDb } from './pg.db';
import { MemoryKv } from './memory.kv';
import { RedisKv } from './redis.kv';
import { DiskBlob } from './disk.blob';
import { S3Blob } from './s3.blob';

/**
 * Composition root for the ports. ONE env var (ADAPTERS) decides whether this
 * process runs on embedded infrastructure (PGlite/memory/disk) or the real
 * thing (Postgres/Redis/S3). Domain modules inject DB/KV/BLOB tokens and are
 * provably indifferent — that indifference is what "stateless gateway" means.
 *
 * @Global(): every domain module needs these; re-importing in each module
 * would be pure noise.
 */
function loadSchema(): string {
  // Search upward so it works from src (tsx), dist (build), and tests.
  let dir = __dirname;
  for (let i = 0; i < 8; i++) {
    const p = path.join(dir, 'infra', 'postgres', 'schema.sql');
    if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8');
    dir = path.dirname(dir);
  }
  throw new Error('infra/postgres/schema.sql not found');
}

@Global()
@Module({
  providers: [
    {
      provide: DB,
      useFactory: async (): Promise<DbPort> => {
        const schema = loadSchema();
        if (config.adapters === 'external') {
          const db = new PgDb();
          await db.init(config.databaseUrl!, schema);
          return db;
        }
        const db = new PgliteDb();
        const dir = process.env.PGLITE_DIR ?? path.join(config.dataDir, 'pglite');
        await db.init(dir, schema);
        return db;
      },
    },
    {
      provide: KV,
      useFactory: async (): Promise<KvPort> => {
        if (config.adapters === 'external') {
          const kv = new RedisKv();
          await kv.init(config.redisUrl!);
          return kv;
        }
        return new MemoryKv();
      },
    },
    {
      provide: BLOB,
      useFactory: async (): Promise<BlobPort> => {
        if (config.adapters === 'external') {
          const blob = new S3Blob();
          await blob.init({
            endpoint: config.s3.endpoint!,
            bucket: config.s3.bucket,
            accessKey: config.s3.accessKey!,
            secretKey: config.s3.secretKey!,
          });
          return blob;
        }
        const blob = new DiskBlob(path.join(config.dataDir, 'media'));
        await blob.init();
        return blob;
      },
    },
  ],
  exports: [DB, KV, BLOB],
})
export class AdaptersModule {}
