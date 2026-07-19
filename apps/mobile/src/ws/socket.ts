import type { C2SEvent, S2CEvent } from '@dcom/shared';
import { useAuthStore } from '../state/authStore';

/**
 * The client half of pipe 1. Native `ws` on the server means WE own the
 * reliability features Socket.io would have given us. Each is small; owning
 * them is the point of the exercise:
 *
 *  - RECONNECT with exponential backoff + jitter (below). Jitter matters:
 *    when your gateway restarts, 10k clients reconnecting at exactly t+1s,
 *    t+2s, t+4s is a self-inflicted DDoS ("thundering herd").
 *  - HEARTBEAT every 30s â€” feeds the Redis presence TTL AND doubles as our
 *    dead-connection detector (mobile radios drop silently; TCP won't tell you).
 *  - RESYNC AFTER RECONNECT is *not* the socket's job: on 'open' the chat
 *    layer pulls REST ?since= â€” pull-based recovery, push-based liveness.
 */

type Listener = (ev: S2CEvent) => void;

const HEARTBEAT_MS = 30_000;
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;

class SocketManager {
  private ws: WebSocket | null = null;
  private listeners = new Set<Listener>();
  private attempts = 0;
  private heartbeat?: ReturnType<typeof setInterval>;
  private closedByUser = false;

  connect() {
    const token = useAuthStore.getState().accessToken;
    if (!token) return;
    this.closedByUser = false;

    this.ws = new WebSocket(`ws://localhost:3000/ws?token=${token}`);

    this.ws.onopen = () => {
      this.attempts = 0;
      this.heartbeat = setInterval(
        () => this.send({ type: 'heartbeat', payload: {} }),
        HEARTBEAT_MS,
      );
    };

    this.ws.onmessage = (e) => {
      const event = JSON.parse(String(e.data)) as S2CEvent;
      this.listeners.forEach((l) => l(event));
    };

    this.ws.onclose = () => {
      clearInterval(this.heartbeat);
      if (this.closedByUser) return;
      // Exponential backoff with full jitter: delay = rand(0, min(max, base*2^n)).
      const cap = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** this.attempts++);
      setTimeout(() => this.connect(), Math.random() * cap);
    };

    this.ws.onerror = () => this.ws?.close();
  }

  send(event: C2SEvent) {
    // Not connected? Drop it. Correctness does NOT depend on this send arriving:
    // chat messages are re-sent from SQLite 'pending' rows on reconnect, and
    // ephemeral events (typing/heartbeat) are worthless to queue.
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(event));
    }
  }

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  disconnect() {
    this.closedByUser = true;
    this.ws?.close();
  }
}

export const socket = new SocketManager();

