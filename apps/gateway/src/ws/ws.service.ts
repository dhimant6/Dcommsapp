import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import type { IncomingMessage } from 'http';
import type { Server as HttpServer } from 'http';
import { WebSocket, WebSocketServer } from 'ws';
import {
  C2SEvent,
  S2CEvent,
  ChatMessageSend,
  ReceiptAck,
  RoomPeer,
  TypingSignal,
} from '@dcom/shared';
import { KV, KvPort } from '../ports/ports';
import { TokensService } from '../auth/tokens.service';
import { ConversationsService } from '../chat/conversations.service';
import { MessagesService } from '../chat/messages.service';
import { MeetingsService } from '../meetings/meetings.service';
import { PushService } from '../push/push.service';

const PRESENCE_TTL_S = 45; // 1.5× the 30s client heartbeat: one lost beat ≠ offline

interface Conn {
  ws: WebSocket;
  userId: string;
  name: string;
  unsubscribe: () => void;
  rooms: Set<string>;
}

/**
 * THE WebSocket gateway — pipe 1.
 *
 * Built on raw `ws` (not @nestjs/websockets): we need to reject bad JWTs
 * DURING the HTTP upgrade (before a socket exists — cheapest DoS surface),
 * and we want our own {type,payload} framing, both of which the Nest
 * decorator layer abstracts away. Nest still provides DI and lifecycle.
 *
 * DELIVERY RULE (the horizontal-scaling keystone): this service NEVER writes
 * directly to another user's socket. Every delivery goes through
 * kv.publish('deliver:{userId}') and comes back via the subscription each
 * connection holds. With MemoryKv that's a local EventEmitter hop; with Redis
 * it's cross-instance — the code cannot tell, so N instances work by
 * construction, not by luck.
 */
@Injectable()
export class WsService implements OnModuleDestroy {
  private log = new Logger('WS');
  private wss = new WebSocketServer({ noServer: true });
  /** userId → live connections ON THIS INSTANCE (multi-tab/multi-device). */
  private conns = new Map<string, Set<Conn>>();

  constructor(
    @Inject(KV) private kv: KvPort,
    private tokens: TokensService,
    private convs: ConversationsService,
    private messages: MessagesService,
    private meetings: MeetingsService,
    private push: PushService,
  ) {}

  attach(server: HttpServer): void {
    server.on('upgrade', (req: IncomingMessage, socket, head) => {
      const url = new URL(req.url ?? '/', 'http://x');
      if (url.pathname !== '/ws') return socket.destroy();
      const claims = this.tokens.verifyAccess(url.searchParams.get('token') ?? '');
      if (!claims) {
        // Reject pre-upgrade: no WebSocket object is ever allocated.
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        return socket.destroy();
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => this.onConnect(ws, claims.sub, claims.name));
    });
  }

  private async onConnect(ws: WebSocket, userId: string, name: string): Promise<void> {
    // Subscribe THIS connection to its user's delivery channel.
    const unsubscribe = await this.kv.subscribe(`deliver:${userId}`, (raw) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(raw);
    });
    const conn: Conn = { ws, userId, name, unsubscribe, rooms: new Set() };
    if (!this.conns.has(userId)) this.conns.set(userId, new Set());
    this.conns.get(userId)!.add(conn);

    const firstConnection = this.conns.get(userId)!.size === 1;
    await this.kv.set(`presence:${userId}`, 'online', PRESENCE_TTL_S);
    if (firstConnection) await this.broadcastPresence(userId, 'online');

    ws.on('message', (data) => void this.onFrame(conn, data.toString()));
    ws.on('close', () => void this.onDisconnect(conn));
    this.log.log(`connect ${name} (${userId.slice(0, 8)})`);
  }

  private async onDisconnect(conn: Conn): Promise<void> {
    conn.unsubscribe();
    for (const roomId of conn.rooms) await this.leaveRoom(conn, roomId, false);
    const set = this.conns.get(conn.userId);
    set?.delete(conn);
    if (set && set.size === 0) {
      this.conns.delete(conn.userId);
      // Last socket gone: presence key will TTL out anyway, but proactively
      // deleting + broadcasting makes "offline" appear in seconds, not 45.
      await this.kv.del(`presence:${conn.userId}`);
      await this.kv.set(`presence:last_seen:${conn.userId}`, String(Date.now()));
      await this.broadcastPresence(conn.userId, 'offline');
    }
  }

  // ---------------- frame router ----------------

  private async onFrame(conn: Conn, raw: string): Promise<void> {
    let event: C2SEvent;
    try {
      event = JSON.parse(raw);
      if (typeof event?.type !== 'string' || typeof event?.payload !== 'object') throw new Error();
    } catch {
      return this.sendTo(conn, { type: 'error', payload: { code: 'BAD_FRAME', message: 'Frames are {type, payload} JSON' } });
    }

    // Flood guard: 100 frames / 10 s / user (typing bursts fit comfortably).
    const hits = await this.kv.incr(`rl:ws:${conn.userId}`, 10);
    if (hits > 100) {
      return this.sendTo(conn, { type: 'error', payload: { code: 'RATE_LIMITED', message: 'Slow down' } });
    }

    try {
      switch (event.type) {
        case 'heartbeat':
          await this.kv.set(`presence:${conn.userId}`, 'online', PRESENCE_TTL_S);
          break;
        case 'chat_message':
          await this.onChatMessage(conn, event.payload);
          break;
        case 'delivery_ack':
          await this.onReceipt(conn, event.payload, 'delivery_ack');
          break;
        case 'read_ack':
          await this.onReceipt(conn, event.payload, 'read_ack');
          break;
        case 'typing':
          await this.onTyping(conn, event.payload);
          break;
        case 'webrtc_offer':
        case 'webrtc_answer':
        case 'ice_candidate':
        case 'call_hangup':
          await this.onRtcRelay(conn, event);
          break;
        case 'room_join':
          await this.joinRoom(conn, event.payload.roomCode, event.payload.displayName);
          break;
        case 'room_leave':
          await this.leaveRoom(conn, event.payload.roomId, true);
          break;
      }
    } catch (e: any) {
      const clientMsgId = (event.payload as any)?.clientMsgId;
      this.sendTo(conn, {
        type: 'error',
        payload: { code: e?.status === 403 ? 'NOT_A_MEMBER' : 'BAD_FRAME', message: e?.message ?? 'error', clientMsgId },
      });
    }
  }

  // ---------------- chat ----------------

  private async onChatMessage(conn: Conn, payload: ChatMessageSend): Promise<void> {
    await this.convs.assertMember(payload.conversationId, conn.userId);
    const msg = await this.messages.persist(conn.userId, conn.name, payload);

    // Ack the SENDER first (single ✓) — before fan-out, so the sender's UI
    // settles even if recipients are slow/offline.
    this.sendTo(conn, { type: 'send_ack', payload: { clientMsgId: msg.clientMsgId, serverMsgId: msg.serverMsgId, createdAt: msg.createdAt } });

    const frame: S2CEvent = { type: 'chat_message', payload: msg };
    for (const uid of await this.convs.memberIds(payload.conversationId)) {
      if (uid === conn.userId) {
        // Other devices/tabs of the sender also need the message (multi-device
        // echo) — but this conn already has the ack, so publish covers them.
        await this.kv.publish(`deliver:${uid}`, JSON.stringify(frame));
        continue;
      }
      const online = await this.kv.get(`presence:${uid}`);
      if (online) {
        await this.kv.publish(`deliver:${uid}`, JSON.stringify(frame));
      } else {
        // Pipe 1 unreachable → push. Recovery of the message itself is the
        // client's REST ?since= sync, NOT a push payload (pushes are lossy
        // and size-limited; they are a doorbell, not a mailbox).
        await this.push.notifyOffline(uid, {
          title: msg.senderName,
          body: msg.msgType === 'text' ? (msg.content.body ?? '') : `[${msg.msgType}]`,
          conversationId: payload.conversationId,
        });
      }
    }
  }

  private async onReceipt(conn: Conn, payload: ReceiptAck, kind: 'delivery_ack' | 'read_ack'): Promise<void> {
    await this.convs.assertMember(payload.conversationId, conn.userId);
    if (kind === 'delivery_ack') await this.messages.markDelivered(payload.messageIds);
    else await this.messages.advanceReadWatermark(payload.conversationId, conn.userId, payload.messageIds);

    // Route receipts to each message's AUTHOR only — receipts about your
    // message are nobody else's traffic.
    const bySender = await this.messages.senderOf(payload.messageIds);
    for (const [senderId, ids] of bySender) {
      if (senderId === conn.userId) continue;
      const frame: S2CEvent = {
        type: kind,
        payload: { conversationId: payload.conversationId, messageIds: ids, userId: conn.userId, at: Date.now() },
      };
      await this.kv.publish(`deliver:${senderId}`, JSON.stringify(frame));
    }
  }

  private async onTyping(conn: Conn, payload: TypingSignal): Promise<void> {
    await this.convs.assertMember(payload.conversationId, conn.userId);
    // Ephemeral: no persistence, no ack, 6s KV TTL purely so "who is typing"
    // could be queried; the event itself is the signal.
    await this.kv.set(`typing:${payload.conversationId}:${conn.userId}`, '1', 6);
    const frame: S2CEvent = {
      type: 'typing',
      payload: { conversationId: payload.conversationId, userId: conn.userId, isTyping: payload.isTyping },
    };
    for (const uid of await this.convs.memberIds(payload.conversationId)) {
      if (uid !== conn.userId) await this.kv.publish(`deliver:${uid}`, JSON.stringify(frame));
    }
  }

  // ---------------- presence ----------------

  /** Presence goes only to users who SHARE a conversation with you (your
   *  contacts see you come online; strangers don't). */
  private async broadcastPresence(userId: string, status: 'online' | 'offline'): Promise<void> {
    const lastSeen = status === 'offline' ? Date.now() : undefined;
    const frame: S2CEvent = { type: 'presence', payload: { userId, status, lastSeenAt: lastSeen } };
    const contacts = new Set<string>();
    for (const conv of await this.listUserConversations(userId)) {
      for (const uid of await this.convs.memberIds(conv)) if (uid !== userId) contacts.add(uid);
    }
    for (const uid of contacts) await this.kv.publish(`deliver:${uid}`, JSON.stringify(frame));
  }

  private async listUserConversations(userId: string): Promise<string[]> {
    const list = await this.convs.listForUser(userId);
    return list.map((c: any) => c.id);
  }

  /** Presence snapshot for the sidebar (REST would also work; WS keeps it live). */
  async presenceOf(userIds: string[]): Promise<Record<string, { status: string; lastSeenAt?: number }>> {
    const out: Record<string, { status: string; lastSeenAt?: number }> = {};
    for (const uid of userIds) {
      const online = await this.kv.get(`presence:${uid}`);
      const last = await this.kv.get(`presence:last_seen:${uid}`);
      out[uid] = online ? { status: 'online' } : { status: 'offline', lastSeenAt: last ? parseInt(last, 10) : undefined };
    }
    return out;
  }

  // ---------------- WebRTC relay (1:1 and room mesh) ----------------

  private async onRtcRelay(conn: Conn, event: C2SEvent): Promise<void> {
    const p: any = event.payload;
    const to = p.toUserId;
    if (!to) return;
    if (!(await this.kv.get(`presence:${to}`))) {
      return this.sendTo(conn, { type: 'error', payload: { code: 'PEER_OFFLINE', message: 'Peer is offline' } });
    }
    // OPAQUE RELAY: stamp the authenticated sender, drop the client's routing
    // field, forward. The sdp/candidate blobs are never inspected.
    const relayed = { type: event.type, payload: { ...p, toUserId: undefined, fromUserId: conn.userId, fromName: conn.name } };
    await this.kv.publish(`deliver:${to}`, JSON.stringify(relayed));
  }

  // ---------------- MTR rooms (mesh coordination) ----------------

  private async joinRoom(conn: Conn, roomCode: string, displayName?: string): Promise<void> {
    let meeting;
    try {
      meeting = await this.meetings.byCode(roomCode);
    } catch {
      return this.sendTo(conn, { type: 'error', payload: { code: 'ROOM_NOT_FOUND', message: `No meeting ${roomCode}` } });
    }
    const key = `room:${meeting.roomId}:peers`;
    const existing = await this.kv.hgetall(key);
    const peers: RoomPeer[] = Object.entries(existing).map(([userId, name]) => ({ userId, displayName: name }));

    await this.kv.hset(key, conn.userId, displayName ?? conn.name);
    conn.rooms.add(meeting.roomId);

    // MESH RULE: joiner gets the current roster and INITIATES an offer to each
    // existing peer (deterministic initiator = no glare). Existing peers just
    // learn the name and wait for the offer.
    this.sendTo(conn, {
      type: 'room_state',
      payload: { roomId: meeting.roomId, roomCode: meeting.roomCode, title: meeting.title, peers },
    });
    const joined: S2CEvent = {
      type: 'room_peer_joined',
      payload: { roomId: meeting.roomId, userId: conn.userId, displayName: displayName ?? conn.name },
    };
    for (const peer of peers) await this.kv.publish(`deliver:${peer.userId}`, JSON.stringify(joined));
  }

  private async leaveRoom(conn: Conn, roomId: string, explicit: boolean): Promise<void> {
    const key = `room:${roomId}:peers`;
    await this.kv.hdel(key, conn.userId);
    if (explicit) conn.rooms.delete(roomId);
    const remaining = await this.kv.hgetall(key);
    const left: S2CEvent = { type: 'room_peer_left', payload: { roomId, userId: conn.userId } };
    for (const uid of Object.keys(remaining)) await this.kv.publish(`deliver:${uid}`, JSON.stringify(left));
  }

  // ---------------- plumbing ----------------

  private sendTo(conn: Conn, event: S2CEvent): void {
    if (conn.ws.readyState === WebSocket.OPEN) conn.ws.send(JSON.stringify(event));
  }

  async onModuleDestroy(): Promise<void> {
    // Graceful drain: 1012 = "service restart" — clients auto-reconnect (and
    // in a multi-instance deploy, land on a surviving instance).
    for (const set of this.conns.values()) for (const c of set) c.ws.close(1012, 'restarting');
    this.wss.close();
  }
}
