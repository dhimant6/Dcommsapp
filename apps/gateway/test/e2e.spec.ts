/**
 * End-to-end test: the ENTIRE gateway on embedded adapters (in-memory PGlite,
 * in-memory KV) — no Docker, no mocks of our own code. What a staging smoke
 * test would exercise, executable in CI on any machine.
 *
 * Covers the full MVP loop:
 *   auth (OTP mock → JWT) → direct conversation → WS connect (JWT upgrade)
 *   → chat with send_ack → delivery_ack/read_ack receipts → typing relay
 *   → offline sync via ?since= → refresh rotation + reuse detection
 *   → meetings + room mesh signaling (join/state/peer events)
 */
import 'reflect-metadata';

process.env.ADAPTERS = 'embedded';
process.env.PGLITE_DIR = 'memory://';
process.env.OTP_MODE = 'mock';
process.env.DATA_DIR = `${__dirname}/.tmp-data`;

import { NestExpressApplication } from '@nestjs/platform-express';
import WebSocket from 'ws';
import { createApp } from '../src/main';
import { WsService } from '../src/ws/ws.service';
import type { S2CEvent, TokenPair } from '@dcom/shared';

let app: NestExpressApplication;
let base: string;

// ---------- helpers ----------

async function rest<T = any>(method: string, path: string, body?: unknown, token?: string): Promise<T> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

async function signup(phone: string, name: string): Promise<TokenPair> {
  const { devCode } = await rest('POST', '/api/auth/otp/request', { phone });
  return rest('POST', '/api/auth/otp/verify', { phone, code: devCode, platform: 'web', displayName: name });
}

/** Typed WS client that queues events so tests can await specific types. */
class TestClient {
  ws!: WebSocket;
  events: S2CEvent[] = [];
  private waiters: { type: string; resolve: (e: any) => void }[] = [];

  async connect(token: string): Promise<void> {
    this.ws = new WebSocket(`${base.replace('http', 'ws')}/ws?token=${token}`);
    await new Promise<void>((resolve, reject) => {
      this.ws.once('open', resolve);
      this.ws.once('error', reject);
    });
    this.ws.on('message', (raw) => {
      const e = JSON.parse(raw.toString()) as S2CEvent;
      const i = this.waiters.findIndex((w) => w.type === e.type);
      if (i >= 0) this.waiters.splice(i, 1)[0].resolve(e);
      else this.events.push(e);
    });
  }

  send(event: any): void {
    this.ws.send(JSON.stringify(event));
  }

  /** Resolves with the next event of `type` (or an already-buffered one).
   *  `match` filters — needed because the pipe is at-least-once: duplicate
   *  deliveries (e.g. after a retried send) are legal and clients dedupe. */
  async next<T extends S2CEvent['type']>(
    type: T,
    match?: (e: Extract<S2CEvent, { type: T }>) => boolean,
    timeoutMs = 5000,
  ): Promise<Extract<S2CEvent, { type: T }>> {
    const fits = (e: S2CEvent) => e.type === type && (!match || match(e as any));
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const buffered = this.events.findIndex(fits);
      if (buffered >= 0) return this.events.splice(buffered, 1)[0] as any;
      const e = await new Promise<any>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), deadline - Date.now());
        this.waiters.push({ type, resolve: (ev) => { clearTimeout(timer); resolve(ev); } });
      });
      if (fits(e)) return e;
      // right type, wrong content (e.g. duplicate delivery) — keep waiting
    }
  }

  close(): void {
    this.ws.close();
  }
}

// ---------- lifecycle ----------

beforeAll(async () => {
  app = await createApp();
  await app.listen(0);
  app.get(WsService).attach(app.getHttpServer());
  const addr = app.getHttpServer().address() as { port: number };
  base = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await app.close();
});

// ---------- tests ----------

describe('auth', () => {
  test('OTP signup issues a working token pair', async () => {
    const pair = await signup('+15550000001', 'AuthUser');
    expect(pair.access).toBeTruthy();
    const me = await rest('GET', '/api/me', undefined, pair.access);
    expect(me.displayName).toBe('AuthUser');
  });

  test('refresh rotates, and reusing a rotated token revokes the family', async () => {
    const pair = await signup('+15550000002', 'Rotator');
    const rotated = await rest('POST', '/api/auth/refresh', { refresh: pair.refresh });
    expect(rotated.refresh).not.toBe(pair.refresh);
    // Replay the OLD token → family nuked
    await expect(rest('POST', '/api/auth/refresh', { refresh: pair.refresh })).rejects.toThrow(/401/);
    // The rotated (newest) token is now ALSO dead — the theft response.
    await expect(rest('POST', '/api/auth/refresh', { refresh: rotated.refresh })).rejects.toThrow(/401/);
  });

  test('bad JWT is rejected at the WS upgrade', async () => {
    const ws = new WebSocket(`${base.replace('http', 'ws')}/ws?token=garbage`);
    const err = await new Promise<string>((resolve) => {
      ws.once('error', (e) => resolve(e.message));
      ws.once('open', () => resolve('opened!'));
    });
    expect(err).toMatch(/401/);
  });
});

describe('chat pipeline', () => {
  let alice: TokenPair, bob: TokenPair;
  let wsA: TestClient, wsB: TestClient;
  let convId: string;

  beforeAll(async () => {
    alice = await signup('+15551110001', 'Alice');
    bob = await signup('+15551110002', 'Bob');
    const conv = await rest('POST', '/api/conversations/direct', { peerPhone: '+15551110002' }, alice.access);
    convId = conv.id;
    wsA = new TestClient();
    wsB = new TestClient();
    await wsA.connect(alice.access);
    await wsB.connect(bob.access);
  });

  afterAll(() => {
    wsA.close();
    wsB.close();
  });

  test('direct conversation creation is idempotent (both directions)', async () => {
    const again = await rest('POST', '/api/conversations/direct', { peerPhone: '+15551110001' }, bob.access);
    expect(again.id).toBe(convId);
  });

  test('message flows A→B with send_ack; retry with same clientMsgId dedupes', async () => {
    const clientMsgId = crypto.randomUUID();
    const frame = {
      type: 'chat_message',
      payload: { clientMsgId, conversationId: convId, msgType: 'text', content: { body: 'hello bob' } },
    };
    wsA.send(frame);
    const [ack, recv] = await Promise.all([wsA.next('send_ack'), wsB.next('chat_message')]);
    expect(ack.payload.clientMsgId).toBe(clientMsgId);
    expect(recv.payload.content.body).toBe('hello bob');
    expect(recv.payload.senderName).toBe('Alice');

    // At-least-once retry → exactly-once storage: same serverMsgId back.
    wsA.send(frame);
    const ack2 = await wsA.next('send_ack');
    expect(ack2.payload.serverMsgId).toBe(ack.payload.serverMsgId);
    const history = await rest('GET', `/api/conversations/${convId}/messages`, undefined, bob.access);
    expect(history.filter((m: any) => m.clientMsgId === clientMsgId)).toHaveLength(1);
  });

  test('delivery and read receipts route back to the sender', async () => {
    const clientMsgId = crypto.randomUUID();
    wsA.send({
      type: 'chat_message',
      payload: { clientMsgId, conversationId: convId, msgType: 'text', content: { body: 'receipts?' } },
    });
    const recv = await wsB.next('chat_message', (e) => e.payload.content.body === 'receipts?');
    const serverMsgId = recv.payload.serverMsgId;

    wsB.send({ type: 'delivery_ack', payload: { conversationId: convId, messageIds: [serverMsgId] } });
    const dAck = await wsA.next('delivery_ack');
    expect(dAck.payload.messageIds).toContain(serverMsgId);

    wsB.send({ type: 'read_ack', payload: { conversationId: convId, messageIds: [serverMsgId] } });
    const rAck = await wsA.next('read_ack');
    expect(rAck.payload.messageIds).toContain(serverMsgId);
    // Watermark advanced → Bob's unread for this conversation is 0.
    const convs = await rest('GET', '/api/conversations', undefined, bob.access);
    expect(convs.find((c: any) => c.id === convId).unread).toBe(0);
  });

  test('typing indicator relays to the peer only', async () => {
    wsB.send({ type: 'typing', payload: { conversationId: convId, isTyping: true } });
    const t = await wsA.next('typing');
    expect(t.payload.isTyping).toBe(true);
    expect(t.payload.userId).toBe(bob.user.id); // stamped by server, not client
  });

  test('offline sync: ?since= returns exactly the missed messages', async () => {
    const history = await rest('GET', `/api/conversations/${convId}/messages`, undefined, alice.access);
    const lastTs = history[history.length - 1].createdAt;

    wsA.send({
      type: 'chat_message',
      payload: { clientMsgId: crypto.randomUUID(), conversationId: convId, msgType: 'text', content: { body: 'while you were away' } },
    });
    await wsA.next('send_ack');

    const missed = await rest('GET', `/api/conversations/${convId}/messages?since=${lastTs}`, undefined, bob.access);
    expect(missed).toHaveLength(1);
    expect(missed[0].content.body).toBe('while you were away');
  });

  test('message search finds my messages, scoped to my conversations', async () => {
    const hits = await rest('GET', '/api/messages/search?q=hello%20bob', undefined, bob.access);
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0].body).toBe('hello bob');
    expect(hits[0].conversationId).toBe(convId);
    // A stranger searching the same term sees nothing — the membership join
    // is the authorization.
    const outsider = await signup('+15551110004', 'Outsider');
    const none = await rest('GET', '/api/messages/search?q=hello%20bob', undefined, outsider.access);
    expect(none).toHaveLength(0);
  });

  test('non-members cannot send into a conversation', async () => {
    const eve = await signup('+15551110003', 'Eve');
    const wsE = new TestClient();
    await wsE.connect(eve.access);
    wsE.send({
      type: 'chat_message',
      payload: { clientMsgId: crypto.randomUUID(), conversationId: convId, msgType: 'text', content: { body: 'intruder' } },
    });
    const err = await wsE.next('error');
    expect(err.payload.code).toBe('NOT_A_MEMBER');
    wsE.close();
  });
});

describe('MTR rooms', () => {
  test('meeting create → join by code → mesh signaling events', async () => {
    const carol = await signup('+15552220001', 'Carol');
    const dave = await signup('+15552220002', 'Dave');
    const wsC = new TestClient();
    const wsD = new TestClient();
    await wsC.connect(carol.access);
    await wsD.connect(dave.access);

    const meeting = await rest('POST', '/api/meetings', { title: 'Standup' }, carol.access);
    expect(meeting.roomCode).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);

    // Carol joins an empty room.
    wsC.send({ type: 'room_join', payload: { roomCode: meeting.roomCode } });
    const stateC = await wsC.next('room_state');
    expect(stateC.payload.peers).toHaveLength(0);

    // Dave joins: his room_state lists Carol; Carol gets peer_joined.
    wsD.send({ type: 'room_join', payload: { roomCode: meeting.roomCode, displayName: 'Dave (Boardroom)' } });
    const [stateD, joined] = await Promise.all([wsD.next('room_state'), wsC.next('room_peer_joined')]);
    expect(stateD.payload.peers.map((p: any) => p.userId)).toContain(carol.user.id);
    expect(joined.payload.displayName).toBe('Dave (Boardroom)');

    // Mesh handshake relays through the room: Dave (joiner) offers to Carol.
    wsD.send({
      type: 'webrtc_offer',
      payload: { callId: crypto.randomUUID(), toUserId: carol.user.id, kind: 'video', roomId: stateD.payload.roomId, sdp: 'fake-sdp-offer' },
    });
    const offer = await wsC.next('webrtc_offer');
    expect(offer.payload.sdp).toBe('fake-sdp-offer');
    expect(offer.payload.fromUserId).toBe(dave.user.id); // server-stamped identity

    // Leave: Carol is told.
    wsD.send({ type: 'room_leave', payload: { roomId: stateD.payload.roomId } });
    const left = await wsC.next('room_peer_left');
    expect(left.payload.userId).toBe(dave.user.id);

    wsC.close();
    wsD.close();
  });

  test('unknown room code yields ROOM_NOT_FOUND', async () => {
    const uma = await signup('+15552220003', 'Uma');
    const wsU = new TestClient();
    await wsU.connect(uma.access);
    wsU.send({ type: 'room_join', payload: { roomCode: 'XXXX-XXXX' } });
    const err = await wsU.next('error');
    expect(err.payload.code).toBe('ROOM_NOT_FOUND');
    wsU.close();
  });
});
