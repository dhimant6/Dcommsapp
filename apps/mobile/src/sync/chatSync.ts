import type { ChatMessageRecv, S2CEvent } from '@dcom/shared';
import { api } from '../api/client';
import * as repo from '../db/chatRepo';
import { useAuthStore } from '../state/authStore';
import { socket } from '../ws/socket';

/**
 * The sync engine — glue between the network and the SQLite cache.
 * Push-based liveness (WS events), pull-based recovery (REST ?since=):
 * a missed WS frame is never a lost message, because the next fullSync()
 * pulls it by cursor, and upserts make replay harmless.
 */

let started = false;

export function startChatSync(): void {
  if (started) return;
  started = true;
  socket.subscribe(applyServerEvent);
  socket.connect();
  void fullSync();
}

/** Pull everything I've missed. Safe to call anytime (pull-to-refresh,
 *  reconnect, cold start) — cursors + upserts make it idempotent. */
export async function fullSync(): Promise<void> {
  const me = useAuthStore.getState().userId;
  const { data: convs } = await api.get<any[]>('/api/conversations');
  for (const c of convs) {
    await repo.upsertConversation({
      id: c.id,
      kind: c.kind,
      title: c.title,
      lastMsgAt: c.lastMessage?.at ?? null,
      unread: c.unread,
      preview: previewOf(c.lastMessage?.type, c.lastMessage?.content),
    });
    const cursor = await repo.getSyncCursor(c.id);
    const { data: page } = await api.get<ChatMessageRecv[]>(
      `/api/conversations/${c.id}/messages${cursor ? `?since=${cursor}` : ''}`,
    );
    const receivedIds: string[] = [];
    for (const m of page) {
      const own = m.senderId === me;
      await repo.upsertServerMessage(m, own ? 'sent' : 'delivered');
      if (!own) receivedIds.push(m.serverMsgId);
      await repo.setSyncCursor(c.id, m.createdAt);
    }
    // Delivery is a fact the moment the rows are stored durably. Read is NOT —
    // that ack waits for the human to open the conversation (ChatRoomScreen).
    if (receivedIds.length) {
      socket.send({ type: 'delivery_ack', payload: { conversationId: c.id, messageIds: receivedIds } });
    }
  }
  await resendPending();
}

/** Replay rows the last session never got acked — the reconnect half of
 *  optimistic send. clientMsgId makes server-side dedupe automatic. */
export async function resendPending(): Promise<void> {
  for (const m of await repo.pendingMessages()) {
    socket.send({
      type: 'chat_message',
      payload: {
        clientMsgId: m.client_msg_id,
        conversationId: m.conversation_id,
        msgType: m.type,
        content: JSON.parse(m.content),
      },
    });
  }
}

export function sendChatMessage(conversationId: string, body: string): void {
  const me = useAuthStore.getState().userId!;
  const clientMsgId = randomUuid();
  const content = { body };
  // Rule #3: SQLite first (UI latency zero), network second.
  void repo
    .insertPending({ clientMsgId, conversationId, senderId: me, msgType: 'text', content })
    .then(() => repo.bumpConversation(conversationId, Date.now(), body, false));
  socket.send({ type: 'chat_message', payload: { clientMsgId, conversationId, msgType: 'text', content } });
}

function applyServerEvent(ev: S2CEvent): void {
  const me = useAuthStore.getState().userId;
  switch (ev.type) {
    case 'chat_message': {
      const m = ev.payload;
      const own = m.senderId === me;
      void repo.upsertServerMessage(m, own ? 'sent' : 'delivered').then(async () => {
        await repo.setSyncCursor(m.conversationId, m.createdAt);
        await repo.bumpConversation(m.conversationId, m.createdAt, previewOf(m.msgType, m.content), !own);
        if (!own) {
          socket.send({ type: 'delivery_ack', payload: { conversationId: m.conversationId, messageIds: [m.serverMsgId] } });
        }
      });
      break;
    }
    case 'send_ack':
      void repo.ackSent(ev.payload.clientMsgId, ev.payload.serverMsgId, ev.payload.createdAt);
      break;
    case 'delivery_ack':
      void repo.markStatuses(ev.payload.messageIds, 'delivered');
      break;
    case 'read_ack':
      void repo.markStatuses(ev.payload.messageIds, 'read');
      break;
    case 'conversation_new':
      void fullSync();
      break;
    default:
      break; // presence/typing/calls: ephemeral, handled by their own modules
  }
}

function previewOf(type?: string, content?: any): string {
  if (!type) return '';
  return type === 'text' ? (content?.body ?? '') : `[${type}]`;
}

/** Hermes has no crypto.randomUUID; RFC4122-v4 from Math.random is fine for an
 *  idempotency key (uniqueness scope is one sender, not the universe). */
function randomUuid(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}
