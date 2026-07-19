# Architecture deep-dive

## Layering: NestJS modules over ports-and-adapters

```
controllers / ws.service        ← protocol edges (HTTP, WebSocket)
services (auth, convs, msgs…)   ← domain logic, plain SQL, no framework magic
ports (DB / KV / BLOB)          ← the interfaces domain code depends on
adapters                        ← embedded: PGlite + memory + disk
                                  external: Postgres + Redis + S3 (compose)
```

Rule that keeps the design honest: **domain code cannot tell which adapter is
live.** The e2e suite runs the entire stack on embedded adapters; staging runs
the identical code on containers. If a feature only works on one side, it leaked
an implementation detail through a port — fix the port.

Why NestJS (vs Go): the workload is ~pure I/O relay, ideal for Node's event
loop; and `packages/shared/protocol.ts` compiling into BOTH client and server
is worth more to a solo learner than Go's higher per-box connection ceiling.
When Node's ceiling matters, the fix is horizontal (stateless instances behind
a balancer), which the KV pub/sub delivery design already permits.

Why raw `ws` + own `{type,payload}` framing (vs Socket.io / Nest gateways):
JWT rejection must happen DURING the HTTP upgrade (before a socket allocates),
and owning reconnect/heartbeat/acks is the curriculum. Socket.io's conveniences
are exactly the parts worth learning to build.

## Delivery semantics (the heart of the course)

At-least-once delivery, exactly-once storage, monotonic receipts:

```
sender ── chat_message{clientMsgId} ──▶ gateway ── INSERT ON CONFLICT ──▶ PG
   ◀──────── send_ack ✓ ────────────────┘ (dupes return the ORIGINAL row)
gateway ── publish deliver:{uid} ──▶ each member's socket (any instance)
   offline member? → push doorbell; recovery = REST ?since= pull, never WS replay
recipient ── delivery_ack ✓✓ / read_ack blue-✓✓ ──▶ routed to message AUTHOR only
   read watermark stored per member (conversation_members), not per message
```

Three ideas to internalize:
1. **Client-generated UUID = idempotency key.** Retries are safe by construction.
2. **One recovery path.** The socket may drop anything; the DB + `?since=` pull
   is the only healer. Two racing healers (replay + pull) is how you get dupes.
3. **Receipts are watermarks.** Per-(message,reader) rows explode at group scale.

## REST vs WS split

| Concern | Pipe | Why |
|---|---|---|
| auth, history sync, presign, meetings CRUD | REST | request/response by nature; idempotent; cacheable |
| live messages, receipts, typing, presence, roster, SDP/ICE | WS | server-push; polling is latency + battery death |

Rule: WS for what the server must push; REST for what the client asks for.

## Security posture

- Access JWT 15 min, verified statelessly (REST guard + WS upgrade). Trade-off:
  revocation lags ≤15 min; instant revocation would need a KV denylist check.
- Refresh tokens: opaque, hashed at rest, rotated per use, **family revocation
  on reuse** (tested in e2e). Client must implement single-flight refresh —
  the web client's `api.ts` shows why.
- WS frames: server stamps `fromUserId` from the JWT; client-supplied identity
  fields are never trusted. Membership is asserted per frame, server-side.
- Rate limits in KV: OTP per phone, frames per user per 10s.
- Media: unguessable keys, size+type limits at presign. Prod adds signed GETs.

## Kubernetes shape (when compose isn't enough)

```
Ingress (TLS 1.3, no sticky sessions needed)
  └─ gateway Deployment ×N  ── HPA on socket count/event-loop lag
       │ SIGTERM → close(1012) drain; clients reconnect anywhere
  ├─ Redis (Cluster)         ← presence, pub/sub fan-out, rate limits
  ├─ PgBouncer → Postgres    ← primary + read replicas
  ├─ LiveKit ×M              ← host-network pods, Redis room routing
  └─ coturn                  ← OUTSIDE the cluster (stable public IPs + UDP ranges)
```

The gateway pods are fungible because: no session state in process memory
(KV), no delivery by local socket lookup (pub/sub), durable state in PG only.
Those three properties were enforced from day one by the ports layer.

## Production gaps (observability et al.)

Console logs only. Production needs: structured logs with correlation ids
across the WS hop, delivery-latency histograms (send→ack, send→delivered),
socket-count/backpressure metrics, and tracing on the REST path. The seams
exist (every frame passes one router in `ws.service.ts`); the plumbing is
omitted to keep the learning surface small.
