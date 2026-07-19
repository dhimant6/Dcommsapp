# Deployment guide

## 1. Local "staging" (what runs today, zero Docker)

```bash
npm install
npm run stage        # tsc build gateway → vite build web → node dist, port 3000
```

One process serves the SPA, REST, media blobs, and WS — single origin, so no
CORS and relative `ws://host/ws` URLs. State lives in `apps/gateway/data/`
(PGlite files + uploaded media). Delete that folder for a factory reset.

Verified on this machine: 11/11 e2e tests; two-browser chat with live
receipts/typing/presence; meeting created from chat and joined from `#/room`
in two tabs with a real P2P (mesh) connection established.

## 2. Containerized staging (requires Docker Desktop + WSL2 on Windows)

```bash
docker compose up -d                       # PG, Redis, MinIO, coturn, LiveKit
docker compose --profile staging up -d     # + gateway container (ADAPTERS=external)
```

Same code; adapters swap via env. `infra/postgres/schema.sql` auto-applies on
first boot. MinIO console: :9001. To run the gateway on the host against the
containers instead: `ADAPTERS=external npm run gateway:dev`.

## 3. Cloud (the pattern, not a script)

- **Gateway**: any container host (Fly.io/Railway/ECS). Needs: WebSocket
  support at the edge, TLS 1.3 termination, `JWT_SECRET` from a secret store,
  and long connection idle timeouts (LBs default to 60s — raise it or the 30s
  heartbeat is your only protection).
- **Postgres/Redis**: managed (RDS/Neon, Elasticache/Upstash). Add PgBouncer
  when instances × pool-size approaches max_connections.
- **S3**: real bucket; set the S3_* env vars, done — the adapter already signs.
- **coturn**: 1–2 small VMs with static IPs, `use-auth-secret` mode; put the
  secret in the gateway env and mint per-call HMAC credentials in
  `/api/calls/ice-config` (static creds are dev-only).
- **LiveKit**: LiveKit Cloud (fastest) or self-host nodes with the Redis they
  already share. Gateway mints room tokens — see docs/mtr-mode.md.

## 4. Mobile → stores (when the RN client is finished)

**Android**: Firebase project → `google-services.json` → `eas build -p android`
(EAS manages the keystore) → Play Console → Internal testing → closed → open →
production. FCM server key goes to the gateway push module.

**iOS**: Apple Developer Program → `eas build -p ios` (EAS handles certs +
provisioning profiles — the part everyone dreads is automated now) →
`eas submit` → TestFlight → App Review. Permission strings for mic/camera/
photos are already in `apps/mobile/app.json`; Push needs an APNs key uploaded
to Firebase so FCM can proxy to iOS.

**Room devices**: the web `#/room` route on any kiosk-capable hardware —
a TV stick with a kiosk browser, a Raspberry Pi in kiosk Chromium, or an
Android tablet with a locked-task launcher pointed at the URL. That is
genuinely how many commercial room systems ship (a locked-down web/Electron
shell). Provision: sign in once with the resource account, bookmark `#/room`.

## 5. CI (`.github/workflows/ci.yml`)

Every push: install → typecheck web → build gateway+web → run the 11-test e2e
suite (embedded adapters — CI needs no services, which is the ports layer
paying rent again). A deploy job stub shows where `docker build` + push to a
registry + `compose --profile staging up` on a staging host would go.
