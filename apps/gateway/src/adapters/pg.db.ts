import { Pool } from 'pg';
import { DbPort } from '../ports/ports';

/**
 * Real Postgres adapter (docker-compose / staging / production path).
 *
 * Pool sizing note: WS gateways hold long-lived processes, so pools never
 * "drain between requests" like in serverless. 10 connections per instance is
 * plenty for the MVP; the scaling fix when instances multiply is PgBouncer in
 * transaction mode, NOT bigger pools (README "what breaks first" #1).
 */
export class PgDb implements DbPort {
  private pool!: Pool;

  async init(databaseUrl: string, schemaSql: string): Promise<void> {
    // Managed Postgres (Neon/Render/Supabase) requires TLS; node-postgres does
    // not reliably infer it from the URL, so switch it on whenever the URL asks
    // for it. rejectUnauthorized:false accepts the provider's CA chain without
    // shipping cert bundles — fine for a learning app, noted as a prod gap.
    const wantsSsl = /sslmode=require|\.neon\.tech|render\.com|supabase\.co/.test(databaseUrl);
    this.pool = new Pool({
      connectionString: databaseUrl,
      max: 10,
      ssl: wantsSsl ? { rejectUnauthorized: false } : undefined,
    });
    // Idempotent bootstrap: compose also applies schema.sql on first boot, but
    // running it here too means a bare Postgres (no init volume) also works.
    await this.pool.query(schemaSql);
  }

  async query<T = any>(sql: string, params: unknown[] = []): Promise<{ rows: T[] }> {
    const res = await this.pool.query(sql, params as any[]);
    return { rows: res.rows as T[] };
  }

  async exec(sql: string): Promise<void> {
    await this.pool.query(sql);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
