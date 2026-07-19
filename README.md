# Dcom — WhatsApp + Teams-Rooms in one learning codebase

> **Learning project.** Every file exists to teach a production pattern:
> two-pipe real-time architecture, delivery semantics, offline-first sync,
> ports-and-adapters, and the WebRTC mesh→SFU trade-off.

**Two personalities, one platform:**
- **Personal mode** (`#/chat`) — WhatsApp shape: 1:1/group chat, ✓/✓✓/blue-✓✓
  receipts, typing, presence, media messages, 1:1 calls.
- **Room mode** (`#/room`) — MTR (Microsoft-Teams-Rooms) shape: a dedicated
  device signs in with a *resource account*, boots to a kiosk hub (clock, "New
  meeting", join-by-code), and joins video meetings. Same backend, same
  protocol — the room console is just another client with different consent
  semantics (joining a room = auto-accept; nobody "answers" a call on a wall panel).

## The two-pipe diagram

```
            ┌──────────────── PIPE 1: CONTROL (WSS /ws) ───────────────────┐
            │ chat, receipts, presence, typing, room roster, SDP/ICE relay │
            └──────────────────────────────────────────────────────────────┘
 ┌────────┐        ┌────────────────────┐      ┌─────────────┐  ┌──────────┐
 │ web /  │──WSS──▶│  Gateway (NestJS)  │─────▶│ DB port     │  │ KV port  │
 │ mobile │◀──WSS──│  REST + WS + blobs │      │ PGlite | PG │  │ mem|Redis│
 │ / room │        └────────────────────┘      └─────────────┘  └──────────┘
 └───┬────┘
     │      ┌──────────────── PIPE 2: MEDIA (SRTP/UDP) ────────────────────┐
     └──────│ 1:1 + small rooms: P2P mesh (coturn when NATs are hostile).  │
            │ Large rooms: LiveKit SFU (docs/mtr-mode.md has the boundary).│
            │ Media bytes NEVER touch the gateway.                          │
            └──────────────────────────────────────────────────────────────┘
```

## Repo map

```
apps/gateway     NestJS modular monolith: REST + WS + media, over ports-and-adapters
apps/web         Vite/React SPA — both personalities; the reference protocol client
apps/mobile      Expo RN skeleton (offline-first SQLite design; see its README)
packages/shared  protocol.ts — the wire contract, imported by client AND server
infra/           schema.sql (runs on PGlite AND real PG), Redis keyspace doc,
                 coturn + LiveKit configs
docs/            architecture, ws protocol, WebRTC flow, MTR mode, deployment
```

## Run it (zero Docker required)

```bash
npm install
npm run stage          # builds gateway+web, serves everything on :3000
# or dev:  npm run gateway:dev  +  npm run web:dev (vite on :5173, proxied)
npm test               # 11 e2e tests: auth→chat→receipts→sync→rooms
```

Open two browser windows on `http://localhost:3000` (one normal, one private —
they need separate localStorage), sign in with two phone numbers (mock OTP is
auto-filled), chat, then hit **📺 Meet** and join the code from `#/room`.

**Why does it run without Postgres/Redis/MinIO?** The gateway is written
against three *ports* (DB, KV, Blob) with two adapters each — embedded
(PGlite in-process Postgres, in-memory KV, disk blobs) and external (real
Postgres, Redis, S3). `ADAPTERS=external` + `docker compose up` swaps the
world with zero code changes. See `apps/gateway/src/ports/ports.ts` for why
this is the same property that makes the gateway horizontally scalable.

## Scaling notes — what breaks first, and the fix

| Order | What breaks | Why | Fix |
|---|---|---|---|
| 0 | **Embedded adapters** | PGlite is single-process; in-memory KV is per-instance | That's what `ADAPTERS=external` is for — this row is the demo of the pattern |
| 1 | **Postgres pool** | long-lived WS instances hold connections forever | PgBouncer (transaction mode), then read replicas for history |
| 2 | **Single WS instance** | user A's socket on instance 1, message handled on 2 | already solved: ALL delivery rides KV pub/sub (`deliver:{userId}`); N instances just work |
| 3 | **Redis memory** | presence keys + pub/sub buffers grow with users | Redis Cluster sharded by userId; Streams with MAXLEN for offline queues |
| 4 | **Mesh CPU/uplink** | N·(N−1) encodes; dies ≈4 video peers | LiveKit SFU per docs/mtr-mode.md — room signaling is already SFU-shaped |
| 5 | **TURN bandwidth** | relayed calls cost full media egress | regional coturn fleet, geo-DNS |

## What I didn't build (deliberately)

- **Message search** (needs async indexing; JSONB `LIKE` doesn't survive scale)
- **Media pipeline** (thumbnails/transcoding/EXIF-strip: S3-event → ffmpeg workers)
- **E2EE** (protocol supports it — server never parses `content`; Double Ratchet
  would slot in client-side; key transparency + multi-device sessions are the hard part)
- **Real FCM/APNs push** (decision logic + full contract in `push.service.ts`; the
  HTTP call is the trivial 10%)
- **Calendar integration for rooms** (real MTR shows the day's bookings; needs
  Graph/Google Calendar OAuth — the hub screen has the slot for it)
- **Abuse/moderation, GDPR deletion, observability** — see docs/architecture.md
