/**
 * PORTS — the interfaces the domain code depends on. Adapters implement them.
 *
 * WHY THIS LAYER EXISTS (hexagonal / ports-and-adapters):
 * The architecture calls for Postgres + Redis + S3, but this dev machine has
 * no Docker. Instead of watering down the design, we define the *seams* the
 * design already implied and provide two implementations of each:
 *
 *   DbPort    → PGlite (embedded, in-process Postgres)  | pg.Pool (real PG)
 *   KvPort    → in-memory Map+TTL+EventEmitter          | ioredis (two conns)
 *   BlobPort  → local disk w/ gateway-served URLs       | S3 presigned URLs
 *
 * The domain modules (auth, messages, ws...) cannot tell which is active —
 * which PROVES the gateway is stateless over external state, the property
 * that makes horizontal scaling work. Swapping adapters is one env var.
 */

export const DB = Symbol('DB');
export const KV = Symbol('KV');
export const BLOB = Symbol('BLOB');

// --- DbPort: minimal SQL surface. Both PGlite and pg use $1-style params and
// return { rows }. We do NOT wrap an ORM: seeing the SQL is a course goal.
export interface DbPort {
  query<T = any>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  /** multi-statement DDL (schema bootstrap) */
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
}

// --- KvPort: the subset of Redis we actually use, so the in-memory adapter
// stays honest (if it's not in this interface, the code can't use it).
export interface KvPort {
  set(key: string, value: string, ttlSec?: number): Promise<void>;
  get(key: string): Promise<string | null>;
  del(key: string): Promise<void>;
  /** INCR with expiry on first increment — the rate-limit primitive. */
  incr(key: string, ttlSec: number): Promise<number>;
  hset(key: string, field: string, value: string): Promise<void>;
  hdel(key: string, field: string): Promise<void>;
  hgetall(key: string): Promise<Record<string, string>>;
  /** Pub/sub — the fan-out backbone. In-memory impl is process-local, which is
   *  exactly equivalent for a single instance; Redis makes it cross-instance. */
  publish(channel: string, message: string): Promise<void>;
  subscribe(channel: string, handler: (message: string) => void): Promise<() => void>;
  close(): Promise<void>;
}

// --- BlobPort: the presigned-URL contract. The client flow is IDENTICAL for
// disk and S3: POST /media/presign → PUT bytes to uploadUrl → send publicUrl
// in the chat message. Media bytes never ride the WebSocket.
export interface BlobPort {
  presignPut(key: string, mime: string): Promise<{ uploadUrl: string; headers: Record<string, string> }>;
  publicUrl(key: string): string;
  /** Disk adapter only: the gateway itself accepts the PUT. S3 mode returns
   *  null here because MinIO/S3 accepts the bytes directly. */
  saveLocal?(key: string, data: Buffer): Promise<void>;
  readLocal?(key: string): Promise<Buffer | null>;
}
