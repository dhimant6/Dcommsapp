/**
 * Dcom WebSocket wire protocol — SINGLE SOURCE OF TRUTH.
 *
 * Imported by the web client, the mobile app, and the gateway. One file defines
 * the contract; a breaking change fails compilation on both ends in the same
 * commit. This is the concrete payoff of choosing TypeScript server-side.
 *
 * DESIGN RULES
 * 1. Every frame is `{ type, payload }` — a discriminated union on `type`.
 * 2. Frames needing confirmation carry a client-generated `clientMsgId`; the
 *    server echoes it in acks. This recreates HTTP's request/response pairing,
 *    which a raw socket does not have.
 * 3. Ephemeral events (typing, presence, room state) have NO acks and NO
 *    persistence. Losing one is harmless by design.
 * 4. WebRTC signaling frames are OPAQUE RELAYS — the gateway routes them by
 *    `toUserId` and never parses SDP.
 * 5. MTR rooms: group calls use a *mesh* of the same 1:1 signaling, coordinated
 *    by room_* events. See docs/mtr-mode.md for why mesh (not SFU) in dev.
 */

// ---------------- Client → Server ----------------

export type C2SEvent =
  | { type: 'chat_message'; payload: ChatMessageSend }
  | { type: 'delivery_ack'; payload: ReceiptAck }
  | { type: 'read_ack'; payload: ReceiptAck }
  | { type: 'typing'; payload: TypingSignal }
  | { type: 'heartbeat'; payload: Record<string, never> }
  | { type: 'webrtc_offer'; payload: RtcOffer }
  | { type: 'webrtc_answer'; payload: RtcAnswer }
  | { type: 'ice_candidate'; payload: RtcIce }
  | { type: 'call_hangup'; payload: CallHangup }
  | { type: 'room_join'; payload: { roomCode: string; displayName?: string } }
  | { type: 'room_leave'; payload: { roomId: string } };

// ---------------- Server → Client ----------------

export type S2CEvent =
  | { type: 'chat_message'; payload: ChatMessageRecv }
  | { type: 'send_ack'; payload: SendAck }
  | { type: 'delivery_ack'; payload: ReceiptEvent }
  | { type: 'read_ack'; payload: ReceiptEvent }
  | { type: 'presence'; payload: PresenceUpdate }
  | { type: 'typing'; payload: TypingSignal }
  | { type: 'webrtc_offer'; payload: RtcOffer }
  | { type: 'webrtc_answer'; payload: RtcAnswer }
  | { type: 'ice_candidate'; payload: RtcIce }
  | { type: 'call_hangup'; payload: CallHangup }
  | { type: 'room_state'; payload: RoomState }
  | { type: 'room_peer_joined'; payload: RoomPeer & { roomId: string } }
  | { type: 'room_peer_left'; payload: { roomId: string; userId: string } }
  | { type: 'conversation_new'; payload: ConversationSummary }
  | { type: 'error'; payload: WsError };

// ---------------- Chat payloads ----------------

export type MsgType = 'text' | 'image' | 'file' | 'audio' | 'call_log' | 'meeting' | 'system';

export interface MsgContent {
  body?: string;
  url?: string;        // media: uploaded FIRST via REST presign; WS carries metadata only
  mime?: string;
  size?: number;
  w?: number;
  h?: number;
  roomCode?: string;   // type 'meeting': join code for an MTR room
  durationS?: number;  // type 'call_log'
}

export interface ChatMessageSend {
  clientMsgId: string;          // idempotency key — UNIQUE(sender_id, client_msg_id) server-side
  conversationId: string;
  msgType: MsgType;
  content: MsgContent;
}

export interface ChatMessageRecv extends ChatMessageSend {
  serverMsgId: string;
  senderId: string;
  senderName: string;
  createdAt: number;            // server clock ms — never trust device clocks for ordering
}

export interface SendAck {
  clientMsgId: string;
  serverMsgId: string;
  createdAt: number;
}

export interface ReceiptAck {
  conversationId: string;
  messageIds: string[];         // batched: opening a chat acks a whole page in one frame
}

export interface ReceiptEvent extends ReceiptAck {
  userId: string;               // who delivered/read
  at: number;
}

export interface PresenceUpdate {
  userId: string;
  status: 'online' | 'offline';
  lastSeenAt?: number;
}

export interface TypingSignal {
  conversationId: string;
  userId?: string;              // stamped by server on relay; client omits
  isTyping: boolean;
}

export interface ConversationSummary {
  id: string;
  kind: 'direct' | 'group';
  title: string;
  memberIds: string[];
  lastMsgAt?: number;
}

// ---------------- WebRTC signaling (opaque relay) ----------------

export interface RtcOffer {
  callId: string;               // correlates all frames of one call/peer-pair
  toUserId?: string;            // c2s target; server swaps in fromUserId on relay
  fromUserId?: string;
  fromName?: string;
  kind: 'audio' | 'video';
  roomId?: string;              // present for room (mesh) calls, absent for 1:1
  sdp: string;
}

export interface RtcAnswer {
  callId: string;
  toUserId?: string;
  fromUserId?: string;
  sdp: string;
}

export interface RtcIce {
  callId: string;
  toUserId?: string;
  fromUserId?: string;
  candidate: unknown;           // RTCIceCandidateInit — opaque to the server
}

export interface CallHangup {
  callId: string;
  toUserId?: string;
  fromUserId?: string;
}

// ---------------- MTR rooms ----------------

export interface RoomPeer {
  userId: string;
  displayName: string;
}

export interface RoomState {
  roomId: string;
  roomCode: string;
  title: string;
  /** Peers already in the room. MESH RULE: the *joiner* initiates a webrtc_offer
   *  to each existing peer — deterministic initiator, no glare. */
  peers: RoomPeer[];
}

export interface WsError {
  code:
    | 'UNAUTHORIZED'
    | 'RATE_LIMITED'
    | 'NOT_A_MEMBER'
    | 'PEER_OFFLINE'
    | 'ROOM_NOT_FOUND'
    | 'BAD_FRAME';
  message: string;
  clientMsgId?: string;
}

// ---------------- REST DTOs shared by clients ----------------

export interface TokenPair {
  access: string;
  refresh: string;
  user: { id: string; phone: string; displayName: string };
}

export interface MeetingInfo {
  roomId: string;
  roomCode: string;
  title: string;
  conversationId?: string;
}
