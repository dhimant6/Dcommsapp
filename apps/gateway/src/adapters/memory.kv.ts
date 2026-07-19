import { EventEmitter } from 'events';
import { KvPort } from '../ports/ports';

/**
 * In-memory KV — Redis semantics for a single process.
 *
 * For ONE gateway instance this is functionally identical to Redis: pub/sub is
 * an EventEmitter, TTLs are timestamps checked on read plus a sweeper. The
 * moment you run TWO instances this adapter is wrong (each has a private
 * universe) — which is precisely the lesson: Redis's job in this architecture
 * is to be the SHARED nervous system across instances, nothing more.
 */
export class MemoryKv implements KvPort {
  private store = new Map<string, { value: string; expiresAt?: number }>();
  private hashes = new Map<string, Map<string, string>>();
  private bus = new EventEmitter();
  private sweeper: NodeJS.Timeout;

  constructor() {
    this.bus.setMaxListeners(0); // one listener per connected socket is expected
    // Lazy expiry (on read) handles correctness; the sweeper just caps memory.
    this.sweeper = setInterval(() => {
      const now = Date.now();
      for (const [k, v] of this.store) if (v.expiresAt && v.expiresAt <= now) this.store.delete(k);
    }, 10_000);
    this.sweeper.unref();
  }

  private live(key: string) {
    const e = this.store.get(key);
    if (!e) return null;
    if (e.expiresAt && e.expiresAt <= Date.now()) {
      this.store.delete(key);
      return null;
    }
    return e;
  }

  async set(key: string, value: string, ttlSec?: number): Promise<void> {
    this.store.set(key, { value, expiresAt: ttlSec ? Date.now() + ttlSec * 1000 : undefined });
  }

  async get(key: string): Promise<string | null> {
    return this.live(key)?.value ?? null;
  }

  async del(key: string): Promise<void> {
    this.store.delete(key);
    this.hashes.delete(key);
  }

  async incr(key: string, ttlSec: number): Promise<number> {
    const e = this.live(key);
    const next = e ? parseInt(e.value, 10) + 1 : 1;
    // Redis parity: expiry set on FIRST increment only, so the window is fixed
    // from the first hit (a rolling window would never expire under load).
    this.store.set(key, { value: String(next), expiresAt: e?.expiresAt ?? Date.now() + ttlSec * 1000 });
    return next;
  }

  async hset(key: string, field: string, value: string): Promise<void> {
    if (!this.hashes.has(key)) this.hashes.set(key, new Map());
    this.hashes.get(key)!.set(field, value);
  }

  async hdel(key: string, field: string): Promise<void> {
    this.hashes.get(key)?.delete(field);
  }

  async hgetall(key: string): Promise<Record<string, string>> {
    return Object.fromEntries(this.hashes.get(key) ?? []);
  }

  async publish(channel: string, message: string): Promise<void> {
    this.bus.emit(channel, message);
  }

  async subscribe(channel: string, handler: (message: string) => void): Promise<() => void> {
    this.bus.on(channel, handler);
    return () => this.bus.off(channel, handler);
  }

  async close(): Promise<void> {
    clearInterval(this.sweeper);
    this.bus.removeAllListeners();
  }
}
