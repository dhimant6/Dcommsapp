# WebRTC signaling flow

## Why a signaling server exists

WebRTC standardizes how peers talk (ICE, DTLS, SRTP) but not how they FIND
each other — two devices behind NATs have no address to exchange SDP at. Our
WebSocket gateway is the reachable rendezvous. It relays signaling frames
opaquely (never parses SDP) and stamps sender identity from the JWT.

## 1:1 call (personal mode)

```
 A                          Gateway                          B
 │ GET /api/calls/ice-config → [{stun…},{turn…}]  (empty list on localhost:
 │                                    host candidates alone connect on a LAN)
 │ getUserMedia (video→audio→viewer fallback)
 │ createOffer → setLocalDescription (starts ICE gathering)
 │ ws webrtc_offer {callId, toUserId:B, sdp} ──▶ stamps fromUserId=A ──▶ ring UI
 │                                              B accepts: getUserMedia,
 │                                              setRemote(offer), createAnswer
 │ ◀── webrtc_answer {callId, sdp} ◀────────────┘
 │ setRemote(answer)
 │ ⇆ ice_candidate frames trickle BOTH ways while the above happens
 │   (trickling shaves seconds off setup vs waiting for full gathering)
 │ ICE connectivity checks run DIRECTLY A↔B: host → srflx(STUN) → relay(TURN)
 │ best pair wins → DTLS → SRTP media flows peer-to-peer
 │ ═══ gateway is now out of the loop; zero media bytes touch our servers ═══
 │ either side: call_hangup {callId} → peer closes the RTCPeerConnection
```

TURN fallback is automatic: if every direct pair fails (symmetric NATs), ICE
falls back to the relay candidates from coturn — no app-level fallback code
exists, only the server list handed out in step 1.

## Room call (MTR mode) — mesh coordination

```
join:   ws room_join {roomCode} → room_state {peers:[…]}
mesh:   the JOINER creates one RTCPeerConnection per existing peer and sends
        webrtc_offer {roomId, toUserId} to each — deterministic initiator, no
        glare. Existing peers auto-answer (joining the room was the consent).
late:   next joiner repeats — everyone already present just answers.
leave:  room_leave / disconnect → room_peer_left → peers close that one pc.
```

A data channel is always created so ICE/DTLS run even for media-less
participants (no camera, headless test, audio-only console) — they appear as
"connected (no camera)" viewers.

## Decision table

| Scenario | Path | Why |
|---|---|---|
| 1:1 | P2P, STUN if needed | lowest latency, zero media infra, E2E by DTLS-SRTP |
| hostile NATs | P2P via TURN relay | ICE falls back automatically |
| room ≤ ~4 video peers | mesh (this repo) | zero infra; upload O(N−1) is still fine |
| room > ~4 | LiveKit SFU | client upload O(1); SFU forwards without re-encoding — see docs/mtr-mode.md for the migration seam |
