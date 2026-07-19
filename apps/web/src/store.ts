import { create } from 'zustand';
import type { ChatMessageRecv, RoomPeer } from '@dcom/shared';

/**
 * Client state. Design mirrors the server's durable/ephemeral split:
 *  - conversations/messages: cache of server truth (re-fetchable anytime)
 *  - presence/typing/calls/room: ephemeral, WS-fed, worthless after refresh
 * The web client keeps messages in memory only; the OFFLINE-FIRST story
 * (SQLite mirror, pending outbox) lives in the mobile app where it matters —
 * a web tab without network is closed, a phone without network is normal.
 */

export type MsgStatus = 'pending' | 'sent' | 'delivered' | 'read';

export interface UiMessage extends ChatMessageRecv {
  status: MsgStatus; // meaningful for OWN messages only
}

export interface Conv {
  id: string;
  kind: 'direct' | 'group';
  title: string;
  members: { id: string; displayName: string; phone: string }[];
  lastMessage: { type: string; content: any; at: number; sender: string } | null;
  unread: number;
}

export interface IncomingCall {
  callId: string;
  fromUserId: string;
  fromName: string;
  kind: 'audio' | 'video';
  sdp: string;
}

interface State {
  user: { id: string; phone: string; displayName: string } | null;
  wsStatus: 'connecting' | 'open' | 'closed';
  conversations: Conv[];
  messages: Record<string, UiMessage[]>;
  activeConvId: string | null;
  presence: Record<string, { status: string; lastSeenAt?: number }>;
  typing: Record<string, Record<string, number>>; // convId → userId → expiresAt ms
  incomingCall: IncomingCall | null;
  activeCall: { callId: string; peerId: string; peerName: string; kind: 'audio' | 'video' } | null;
  room: { roomId: string; roomCode: string; title: string; peers: RoomPeer[] } | null;

  set: (partial: Partial<State>) => void;
  upsertConv: (c: Conv) => void;
  addMessage: (convId: string, m: UiMessage) => void;
  patchMessage: (convId: string, clientMsgId: string, patch: Partial<UiMessage>) => void;
  markStatuses: (convId: string, messageIds: string[], status: MsgStatus) => void;
  setTyping: (convId: string, userId: string, isTyping: boolean) => void;
}

export const useStore = create<State>((set, get) => ({
  user: null,
  wsStatus: 'closed',
  conversations: [],
  messages: {},
  activeConvId: null,
  presence: {},
  typing: {},
  incomingCall: null,
  activeCall: null,
  room: null,

  set: (partial) => set(partial as any),

  upsertConv: (c) =>
    set((s) => {
      const rest = s.conversations.filter((x) => x.id !== c.id);
      return { conversations: [c, ...rest] };
    }),

  addMessage: (convId, m) =>
    set((s) => {
      const list = s.messages[convId] ?? [];
      // Dedupe by clientMsgId (covers REST-sync + live-WS overlap: the same
      // message can legally arrive via both paths; idempotent merge is the
      // client half of exactly-once).
      if (list.some((x) => x.clientMsgId === m.clientMsgId)) return s;
      const next = [...list, m].sort((a, b) => a.createdAt - b.createdAt);
      return { messages: { ...s.messages, [convId]: next } };
    }),

  patchMessage: (convId, clientMsgId, patch) =>
    set((s) => {
      const list = s.messages[convId] ?? [];
      return {
        messages: {
          ...s.messages,
          [convId]: list.map((m) => (m.clientMsgId === clientMsgId ? { ...m, ...patch } : m)),
        },
      };
    }),

  markStatuses: (convId, messageIds, status) =>
    set((s) => {
      const ids = new Set(messageIds);
      const rank: Record<MsgStatus, number> = { pending: 0, sent: 1, delivered: 2, read: 3 };
      const list = (s.messages[convId] ?? []).map((m) =>
        ids.has(m.serverMsgId) && rank[status] > rank[m.status] ? { ...m, status } : m,
      );
      return { messages: { ...s.messages, [convId]: list } };
    }),

  setTyping: (convId, userId, isTyping) =>
    set((s) => {
      const conv = { ...(s.typing[convId] ?? {}) };
      if (isTyping) conv[userId] = Date.now() + 6000;
      else delete conv[userId];
      return { typing: { ...s.typing, [convId]: conv } };
    }),
}));
