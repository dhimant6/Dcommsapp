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

/** Per-port external/embedded decision. 'auto' picks external only when that
 *  port's config env is present — so partial upgrades (e.g. just a managed
 *  Postgres for persistence) need exactly one env var, not a full stack. */
function wantExternal(hasConfig: boolean): boolean {
  if (config.adapters === 'external') return true;
  if (config.adapters === 'auto') return hasConfig;
  return false;
}

@Global()
@Module({
  providers: [
    {
      provide: DB,
      useFactory: async (): Promise<DbPort> => {
        const schema = loadSchema();
        if (wantExternal(!!config.databaseUrl)) {
          const db = new PgDb();
          await db.init(config.databaseUrl!, schema);
          console.log('[adapters] DB: postgres');
          return db;
        }
        const db = new PgliteDb();
        const dir = process.env.PGLITE_DIR ?? path.join(config.dataDir, 'pglite');
        await db.init(dir, schema);
        console.log('[adapters] DB: pglite (embedded)');
        return db;
      },
    },
    {
      provide: KV,
      useFactory: async (): Promise<KvPort> => {
        if (wantExternal(!!config.redisUrl)) {
          const kv = new RedisKv();
          await kv.init(config.redisUrl!);
          console.log('[adapters] KV: redis');
          return kv;
        }
        console.log('[adapters] KV: in-memory (single instance only)');
        return new MemoryKv();
      },
    },
    {
      provide: BLOB,
      useFactory: async (): Promise<BlobPort> => {
        if (wantExternal(!!(config.s3.endpoint && config.s3.accessKey && config.s3.secretKey))) {
          const blob = new S3Blob();
          await blob.init({
            endpoint: config.s3.endpoint!,
            bucket: config.s3.bucket,
            accessKey: config.s3.accessKey!,
            secretKey: config.s3.secretKey!,
          });
          console.log('[adapters] BLOB: s3');
          return blob;
        }
        const blob = new DiskBlob(path.join(config.dataDir, 'media'));
        await blob.init();
        console.log('[adapters] BLOB: disk');
        return blob;
      },
    },
  ],
  exports: [DB, KV, BLOB],
})
export class AdaptersModule {}
