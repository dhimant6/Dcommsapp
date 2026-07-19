# Redis keyspace — the "schema" for our schemaless store

Redis has no DDL, so this document **is** the schema. Every key pattern the gateway
touches is defined here. Rule of thumb: if data can be *regenerated* or is only
meaningful *right now*, it belongs in Redis with a TTL — never in Postgres.

## Presence

| Key | Type | TTL | Written by | Meaning |
|---|---|---|---|---|
| `presence:{userId}` | string `"online"` | **45s** | Gateway, on WS connect + every 30s heartbeat | User is online. TTL 45s = 1.5× the 30s heartbeat, so ONE dropped heartbeat doesn't flap the user offline, but a dead connection expires within a minute. **This is the core trick: we never write "offline" — absence of the key IS offline.** No cleanup job, no stale state after a crash. |
| `presence:last_seen:{userId}` | string ISO-8601 | none | Gateway, on WS disconnect | Powers "last seen 14:32". Persistent-ish; acceptable to lose on Redis restart (degrades to "recently"). |

## Typing indicators

| Key | Type | TTL | Meaning |
|---|---|---|---|
| `typing:{conversationId}:{userId}` | string `"1"` | **6s** | Set on every `typing` WS event (client emits at most every 4s while typing). Expiry = indicator disappears by itself; a client that crashes mid-typing never shows "typing…" forever. Never touches Postgres — this data is worthless 6 seconds later. |

## Pub/Sub channels (multi-instance fan-out)

| Channel | Payload | Why it exists |
|---|---|---|
| `deliver:{userId}` | full WS event JSON | **The horizontal-scaling keystone.** When gateway instance A handles a send to user B, it does NOT look for B's socket locally — it publishes to `deliver:{B}`. Every instance subscribes (via pattern or per-connected-user SUBSCRIBE); the one holding B's socket forwards the frame. Result: N stateless gateway instances behind a dumb load balancer, no sticky sessions for delivery. |
| `conv:{conversationId}` | full WS event JSON | Group fan-out. One publish per message instead of N `deliver:` publishes; instances forward to whichever members they hold. Avoids the N-publishes-per-group-message write amplification. |

## Offline queue (advanced module — Redis Streams)

| Key | Type | Notes |
|---|---|---|
| `queue:{userId}` | STREAM, `MAXLEN ~ 1000` | Pub/Sub is fire-and-forget: if B is offline, the publish evaporates (that's fine — history sync via REST `?since=` recovers it). Streams add a *durable* per-user queue for the advanced module, letting a reconnecting client drain missed events without hitting Postgres. Capped length: Redis is a cache here, Postgres remains the source of truth. |

## Sessions & rate limiting

| Key | Type | TTL | Meaning |
|---|---|---|---|
| `session:{userId}:{deviceId}` | hash `{instanceId, connectedAt}` | 45s, refreshed with heartbeat | Which gateway instance holds this device's socket. Used for targeted routing and the multi-device module. |
| `rl:otp:{phone}` | counter | 10 min | INCR + EXPIRE on first hit; deny when > 3. Protects the (mock) SMS budget from enumeration. |
| `rl:ws:{userId}` | counter | 10s window | Max ~50 WS events / 10s / user. A buggy or hostile client can't flood group fan-out. |

## Why not "just use Postgres for presence"?

Presence changes on every heartbeat (every user, every 30s). 10k online users =
~333 writes/sec of data nobody needs durably, bloating WAL and vacuum. Redis absorbs
this at negligible cost, and TTL gives us crash-safety *for free* — the absence of a
cleanup job is a feature, not an omission.
