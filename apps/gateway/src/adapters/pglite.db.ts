import { PGlite } from '@electric-sql/pglite';
import * as fs from 'fs';
import * as path from 'path';
import { DbPort } from '../ports/ports';

/**
 * Embedded Postgres via PGlite (Postgres compiled to WASM, running in-process).
 *
 * WHY: real Postgres semantics — JSONB, TIMESTAMPTZ, ON CONFLICT, the exact
 * schema.sql we ship for the containerized path — with zero installed services.
 * The SQL in the domain modules is written ONCE and runs on both engines.
 *
 * LIMITATION (worth knowing): PGlite is single-connection, no concurrent
 * writers across processes. Fine for one dev gateway; the external adapter
 * (pg.Pool) is the multi-instance answer.
 */
export class PgliteDb implements DbPort {
  private db!: PGlite;

  /** dataDir: filesystem path for persistence, or 'memory://' for tests. */
  async init(dataDir: string, schemaSql: string): Promise<void> {
    if (dataDir !== 'memory://') fs.mkdirSync(path.dirname(dataDir), { recursive: true });
    this.db = new PGlite(dataDir === 'memory://' ? undefined : dataDir);
    await this.db.exec(schemaSql); // idempotent: schema uses IF NOT EXISTS throughout
  }

  async query<T = any>(sql: string, params: unknown[] = []): Promise<{ rows: T[] }> {
    const res = await this.db.query<T>(sql, params as any[]);
    return { rows: res.rows };
  }

  async exec(sql: string): Promise<void> {
    await this.db.exec(sql);
  }

  async close(): Promise<void> {
    await this.db.close();
  }
}
