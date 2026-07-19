# WebSocket event protocol

Executable source of truth: [`packages/shared/src/protocol.ts`](../packages/shared/src/protocol.ts)
(typed discriminated union imported by web, mobile, and gateway). This doc is
the narrative view.

## Connection lifecycle

```
wss://host/ws?token=<accessJWT>
```

1. Token rides a query param because the browser WebSocket API cannot set
   headers on the upgrade (platform limitation, not preference). Mitigations:
   TLS covers the URL in transit; never log upgrade URLs.
2. The gateway verifies the JWT **during the HTTP upgrade** — bad tokens get
   `401` before a WebSocket object exists (cheapest rejection; tested in e2e).
3. On connect the gateway: registers the socket, SUBSCRIBEs `deliver:{userId}`
   on the KV bus, writes `presence:{userId}` (TTL 45s), broadcasts `presence`
   to users sharing a conversation.
4. Client heartbeats every 30s (TTL 45 = 1.5×: one lost beat ≠ offline).
5. Mid-connection token expiry does NOT drop the socket (authenticated at
   upgrade); the next reconnect needs a fresh token via REST refresh.

## Event catalogue

| type | dir | persisted? | acked? | notes |
|---|---|---|---|---|
| `chat_message` | C→S, S→C | ✅ Postgres | ✅ `send_ack` | the only durable event; `clientMsgId` = idempotency key |
| `send_ack` | S→C | — | — | single ✓, pairs by `clientMsgId` |
| `delivery_ack` / `read_ack` | both | watermark | — | batched `messageIds`; routed to each message's AUTHOR only |
| `presence` | S→C | KV TTL | ❌ | only to users sharing a conversation |
| `typing` | both | ❌ never | ❌ | 6s KV TTL; throttled client-side to 1/4s |
| `heartbeat` | C→S | ❌ | ❌ | refreshes presence TTL |
| `webrtc_offer/answer`, `ice_candidate`, `call_hangup` | both | ❌ | ❌ | opaque relay; server stamps `fromUserId` from JWT, never trusts client identity |
| `room_join` / `room_leave` | C→S | roster in KV | via `room_state` | MTR rooms; code → roster |
| `room_state` / `room_peer_joined` / `room_peer_left` | S→C | ❌ | — | mesh coordination: JOINER offers to existing peers |
| `conversation_new` | S→C | — | — | sidebar refresh hint |
| `error` | S→C | — | — | `UNAUTHORIZED · RATE_LIMITED · NOT_A_MEMBER · PEER_OFFLINE · ROOM_NOT_FOUND · BAD_FRAME` |

## Delivery semantics

```
sender                     gateway                     recipient
  │ chat_message{clientMsgId} │                            │
  │──────────────────────────▶│ INSERT … ON CONFLICT       │
  │       send_ack ✓          │ (dupes → original row)     │
  │◀──────────────────────────│                            │
  │                           │ publish deliver:{B} ──────▶│  (offline → push doorbell)
  │      delivery_ack ✓✓      │◀── delivery_ack ───────────│
  │◀──────────────────────────│                            │
  │      read_ack (blue)      │◀── read_ack (watermark) ───│
```

- Sender retries until `send_ack` → at-least-once toward the server.
- UNIQUE(sender_id, client_msg_id) → exactly-once storage; clients also dedupe
  by `clientMsgId` because DELIVERY may legally duplicate.
- Offline recovery is REST `GET /api/conversations/:id/messages?since=` — one
  pull-based healer, never WS replay racing it.
