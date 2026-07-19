# MTR mode — how "Teams Rooms" maps onto a WhatsApp backend

## The insight this module teaches

A Teams-Rooms-style deployment is NOT a different system — it's a different
**client personality** over the same real-time core:

| Concept | Personal (WhatsApp) | Room device (MTR) |
|---|---|---|
| Identity | person's phone number | **resource account** phone number (`users.is_room_device`) |
| Home screen | chat list | kiosk hub: clock + join-by-code + new-meeting |
| Call consent | ring → human accepts | joining the room IS consent (auto-accept mesh offers) |
| Chat surface | primary | none — the console is a meeting endpoint |
| Session | person logs in/out | provisioned once, signed in forever (long-lived refresh family) |

That's why the whole feature costs: one `is_room_device` column, one `meetings`
table, four `room_*` WS events, and one alternate UI route (`#/room`). The
messaging pipeline, auth, presence, and signaling relay are untouched.

## Meeting lifecycle

```
1. Any user: POST /api/meetings  →  { roomCode: "ABCD-EFGH" }   (24h TTL, Postgres)
   — from chat, "📺 Meet" also drops a `meeting` message with the code into the
     conversation, so phones/laptops join by tapping and rooms join by typing.
2. Client: ws room_join {roomCode}
   — server resolves the code, adds you to the KV roster `room:{id}:peers`,
     replies room_state {peers}, broadcasts room_peer_joined to the others.
3. Media: MESH. The JOINER creates a webrtc_offer (roomId tagged) to each peer
   already present — deterministic initiator, so no glare. Peers auto-answer.
4. room_leave / disconnect → roster cleanup + room_peer_left; each side closes
   the matching RTCPeerConnection.
```

Durable/ephemeral split, again: the meeting **code** must survive a gateway
restart (it's in an invite that went out an hour ago) → Postgres. Who is in the
room right now is worthless after the fact → KV with the connection lifecycle.

## Why mesh, and where it dies

Mesh = every participant sends media to every other participant directly.

- **Pro:** zero media infrastructure, lowest possible latency, E2E-encrypted by
  DTLS-SRTP with no server in the media path at all.
- **Con:** each client encodes+uploads N−1 streams. Phones die at N≈4 video
  participants (uplink + battery + encoder).

The **SFU boundary** (LiveKit, configured in infra/livekit + docker-compose):
each client uploads ONCE; the SFU forwards packets without re-encoding. The
migration is intentionally cheap because the signaling shape doesn't change:
`room_join` stops returning a peer roster for mesh offers and instead returns a
LiveKit access token; the tile grid subscribes to SFU tracks instead of mesh
`ontrack` events. The gateway's role shrinks to *token authority* — the same
authorize-then-get-out-of-the-way pattern as S3 presigned uploads.

## No-camera semantics (deliberate)

`getUserMedia` failures degrade: video+audio → audio-only → **viewer mode**
(recvonly + a data channel so ICE still runs). A room console without a camera,
a laptop with a broken mic, or an automated test in a headless browser all join
successfully and show as "connected (no camera)". Meetings must never fail
closed on device problems — that's a hard-won videoconferencing lesson.

## What a production MTR adds (not built)

- **Calendar binding**: the hub shows the room's bookings (Graph/Google OAuth),
  one-tap join for the next meeting.
- **Proximity join & content share**: ultrasonic/BLE pairing, wireless HDMI ingest.
- **Peripheral health**: camera/mic/display monitoring, remote management
  (this is most of what commercial MTR licenses actually sell — see the
  Fleetline project for the management-console side of this world).
- **Dual-screen layouts, active-speaker detection** (SFU-side audio levels).
