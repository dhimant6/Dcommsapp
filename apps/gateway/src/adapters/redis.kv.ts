import Redis from 'ioredis';
import { KvPort } from '../ports/ports';

/**
 * Real Redis adapter (docker-compose / staging path).
 *
 * TWO connections on purpose — the classic Redis gotcha: a connection in
 * SUBSCRIBE mode may not issue normal commands (SET/GET/INCR). So `sub` only
 * subscribes and `cmd` does everything else. ioredis would throw at runtime
 * if we mixed them; wiring it correctly up front is cheaper than learning
 * this from a production stack trace.
 */
export class RedisKv implements KvPort {
  private cmd!: Redis;
  private sub!: Redis;
  private handlers = new Map<string, Set<(m: string) => void>>();

  async init(redisUrl: string): Promise<void> {
    this.cmd = new Redis(redisUrl);
    this.sub = new Redis(redisUrl);
    this.sub.on('message', (channel: string, message: string) => {
      this.handlers.get(channel)?.forEach((h) => h(message));
    });
  }

  async set(key: string, value: string, ttlSec?: number): Promise<void> {
    if (ttlSec) await this.cmd.set(key, value, 'EX', ttlSec);
    else await this.cmd.set(key, value);
  }

  async get(key: string): Promise<string | null> {
    return this.cmd.get(key);
  }

  async del(key: string): Promise<void> {
    await this.cmd.del(key);
  }

  async incr(key: string, ttlSec: number): Promise<number> {
    const n = await this.cmd.incr(key);
    if (n === 1) await this.cmd.expire(key, ttlSec); // fixed window from first hit
    return n;
  }

  async hset(key: string, field: string, value: string): Promise<void> {
    await this.cmd.hset(key, field, value);
  }

  async hdel(key: string, field: string): Promise<void> {
    await this.cmd.hdel(key, field);
  }

  async hgetall(key: string): Promise<Record<string, string>> {
    return this.cmd.hgetall(key);
  }

  async publish(channel: string, message: string): Promise<void> {
    await this.cmd.publish(channel, message);
  }

  async subscribe(channel: string, handler: (message: string) => void): Promise<() => void> {
    if (!this.handlers.has(channel)) {
      this.handlers.set(channel, new Set());
      await this.sub.subscribe(channel);
    }
    this.handlers.get(channel)!.add(handler);
    return () => {
      const set = this.handlers.get(channel);
      set?.delete(handler);
      if (set && set.size === 0) {
        this.handlers.delete(channel);
        void this.sub.unsubscribe(channel); // stop paying for silent channels
      }
    };
  }

  async close(): Promise<void> {
    this.cmd.disconnect();
    this.sub.disconnect();
  }
}
