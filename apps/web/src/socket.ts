import type { C2SEvent, S2CEvent } from '@dcom/shared';
import { api, getAccessToken } from './api';
import { useStore } from './store';

/**
 * Pipe 1, client side. We own what Socket.io would have hidden:
 *  - reconnect with exponential backoff + FULL JITTER (a restarting server
 *    must not be greeted by 10k synchronized reconnects)
 *  - 30s heartbeat (feeds server presence TTL; detects silently-dead radios)
 *  - resync-on-reconnect: pull-based — REST ?since= per conversation, because
 *    the socket is allowed to be lossy; the DB is the source of truth.
 */

const HEARTBEAT_MS = 30_000;
let ws: WebSocket | null = null;
let attempts = 0;
let heartbeat: number | undefined;
let closedByUser = false;
/** Extra dispatch hooks (rtc.ts registers one). Store-independent so the
 *  signaling layer doesn't import UI state. */
const listeners = new Set<(e: S2CEvent) => void>();

export function onWsEvent(l: (e: S2CEvent) => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function wsSend(event: C2SEvent) {
  // Drop when closed — correctness never depends on a single send arriving:
  // chat has the pending-outbox + resync, ephemeral events are worthless late.
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(event));
}

export function wsConnect() {
  const token = getAccessToken();
  if (!token) return;
  closedByUser = false;
  useStore.getState().set({ wsStatus: 'connecting' });

  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws?token=${token}`);

  ws.onopen = () => {
    attempts = 0;
    useStore.getState().set({ wsStatus: 'open' });
    heartbeat = window.setInterval(() => wsSend({ type: 'heartbeat', payload: {} }), HEARTBEAT_MS);
    void resync();
  };

  ws.onmessage = (e) => {
    const event = JSON.parse(String(e.data)) as S2CEvent;
    dispatch(event);
    listeners.forEach((l) => l(event));
  };

  ws.onclose = () => {
    window.clearInterval(heartbeat);
    useStore.getState().set({ wsStatus: 'closed' });
    if (closedByUser) return;
    const cap = Math.min(30_000, 1_000 * 2 ** attempts++);
    setTimeout(() => wsConnect(), Math.random() * cap); // full jitter
  };

  ws.onerror = () => ws?.close();
}

export function wsDisconnect() {
  closedByUser = true;
  ws?.close();
}

/** Reconnect recovery: refresh the conversation list, then pull missed
 *  messages for the ACTIVE conversation via ?since=. Other conversations
 *  heal lazily when opened — no need to hydrate the world. */
async function resync() {
  const s = useStore.getState();
  try {
    const convs = await api<any[]>('GET', '/api/conversations');
    s.set({ conversations: convs });
    if (s.activeConvId) {
      const msgs = s.messages[s.activeConvId] ?? [];
      const since = msgs.length ? msgs[msgs.length - 1].createdAt : undefined;
      const missed = await api<any[]>(
        'GET',
        `/api/conversations/${s.activeConvId}/messages${since ? `?since=${since}` : ''}`,
      );
      for (const m of missed) {
        s.addMessage(s.activeConvId, { ...m, status: 'delivered' });
      }
    }
  } catch {
    /* next reconnect retries */
  }
}

function dispatch(event: S2CEvent) {
  const s = useStore.getState();
  switch (event.type) {
    case 'chat_message': {
      const m = event.payload;
      const own = m.senderId === s.user?.id;
      s.addMessage(m.conversationId, { ...m, status: own ? 'sent' : 'delivered' });
      if (!own) {
        // Device-level receipt, immediately: "it reached my client".
        wsSend({ type: 'delivery_ack', payload: { conversationId: m.conversationId, messageIds: [m.serverMsgId] } });
        // Human-level receipt only if the conversation is on screen.
        if (s.activeConvId === m.conversationId && document.visibilityState === 'visible') {
          wsSend({ type: 'read_ack', payload: { conversationId: m.conversationId, messageIds: [m.serverMsgId] } });
        }
      }
      // Sidebar: bump conversation ordering/preview (cheap local update; full
      // truth comes from the next /api/conversations fetch).
      const conv = s.conversations.find((c) => c.id === m.conversationId);
      if (conv) {
        s.upsertConv({
          ...conv,
          lastMessage: { type: m.msgType, content: m.content, at: m.createdAt, sender: m.senderName },
          unread: !own && s.activeConvId !== m.conversationId ? conv.unread + 1 : conv.unread,
        });
      } else {
        void api<any[]>('GET', '/api/conversations').then((convs) => s.set({ conversations: convs }));
      }
      break;
    }
    case 'send_ack': {
      // Pair by clientMsgId; backfill the server identity.
      for (const [convId, list] of Object.entries(s.messages)) {
        if (list.some((m) => m.clientMsgId === event.payload.clientMsgId)) {
          s.patchMessage(convId, event.payload.clientMsgId, {
            status: 'sent',
            serverMsgId: event.payload.serverMsgId,
            createdAt: event.payload.createdAt,
          });
        }
      }
      break;
    }
    case 'delivery_ack':
      s.markStatuses(event.payload.conversationId, event.payload.messageIds, 'delivered');
      break;
    case 'read_ack':
      s.markStatuses(event.payload.conversationId, event.payload.messageIds, 'read');
      break;
    case 'presence':
      s.set({
        presence: {
          ...s.presence,
          [event.payload.userId]: { status: event.payload.status, lastSeenAt: event.payload.lastSeenAt },
        },
      });
      break;
    case 'typing':
      if (event.payload.userId) s.setTyping(event.payload.conversationId, event.payload.userId, event.payload.isTyping);
      break;
    case 'webrtc_offer': {
      const p = event.payload;
      // 1:1 incoming call → ring UI. Room-mesh offers (roomId set) are handled
      // by rtc.ts via onWsEvent — consent was given by joining the room.
      if (!p.roomId) {
        s.set({
          incomingCall: { callId: p.callId, fromUserId: p.fromUserId!, fromName: p.fromName ?? 'Unknown', kind: p.kind, sdp: p.sdp },
        });
      }
      break;
    }
    case 'call_hangup':
      if (s.incomingCall?.callId === event.payload.callId) s.set({ incomingCall: null });
      break;
    case 'room_state':
      s.set({ room: { ...event.payload } });
      break;
    case 'room_peer_joined':
      if (s.room?.roomId === event.payload.roomId) {
        s.set({
          room: {
            ...s.room,
            peers: [...s.room.peers.filter((p) => p.userId !== event.payload.userId), { userId: event.payload.userId, displayName: event.payload.displayName }],
          },
        });
      }
      break;
    case 'room_peer_left':
      if (s.room?.roomId === event.payload.roomId) {
        s.set({ room: { ...s.room, peers: s.room.peers.filter((p) => p.userId !== event.payload.userId) } });
      }
      break;
    case 'error':
      console.warn('[ws error]', event.payload);
      break;
  }
}
