import type { S2CEvent } from '@dcom/shared';
import { api } from './api';
import { onWsEvent, wsSend } from './socket';

/**
 * Pipe 2 — WebRTC peer management for both call shapes:
 *   1:1  — explicit ring/accept; one RTCPeerConnection.
 *   room — MESH: one RTCPeerConnection per remote peer; the JOINER offers to
 *          every existing peer (deterministic initiator = no glare), answers
 *          arrive as peers accept. Auto-accept inside a room: consent was
 *          given by joining.
 *
 * MESH LIMIT: upload grows O(N-1) per client; beyond ~4 video peers, phones
 * and laptops choke. That is the SFU boundary — LiveKit replaces this class
 * for big rooms (docs/mtr-mode.md), the signaling protocol stays the same.
 *
 * MEDIA FALLBACK: getUserMedia is tried video+audio → audio → none. "None"
 * still builds the connection (recvonly + a data channel) so a device without
 * camera/mic — or a headless test — can join a room as a viewer. MTR hardware
 * reality: consoles sometimes have no camera; the meeting must not care.
 */

type PeerEvents = {
  onTrack: (userId: string, stream: MediaStream) => void;
  onState: (userId: string, state: string) => void;
  onLocalStream: (stream: MediaStream | null) => void;
};

export class RtcManager {
  private peers = new Map<string, RTCPeerConnection>(); // remote userId → pc
  private callIds = new Map<string, string>();          // remote userId → callId
  private local: MediaStream | null = null;
  private ice: RTCIceServer[] = [];
  private unsub: (() => void) | null = null;
  private roomId: string | null = null;

  constructor(private events: PeerEvents) {}

  async init(kind: 'audio' | 'video'): Promise<void> {
    this.ice = (await api<any>('GET', '/api/calls/ice-config')).iceServers;
    this.local = await this.acquireMedia(kind);
    this.events.onLocalStream(this.local);
    this.unsub = onWsEvent((e) => void this.onSignal(e));
  }

  private async acquireMedia(kind: 'audio' | 'video'): Promise<MediaStream | null> {
    const tries: MediaStreamConstraints[] =
      kind === 'video'
        ? [{ video: { width: 1280 }, audio: true }, { audio: true }, ]
        : [{ audio: true }];
    for (const c of tries) {
      try {
        return await navigator.mediaDevices.getUserMedia(c);
      } catch {
        /* next fallback */
      }
    }
    return null; // viewer mode — still joinable
  }

  private newPeer(remoteId: string, callId: string): RTCPeerConnection {
    const pc = new RTCPeerConnection({ iceServers: this.ice });
    this.peers.set(remoteId, pc);
    this.callIds.set(remoteId, callId);

    for (const track of this.local?.getTracks() ?? []) pc.addTrack(track, this.local!);

    // TRICKLE ICE: forward every candidate as it appears — call setup overlaps
    // with candidate gathering instead of waiting for it.
    pc.onicecandidate = (e) => {
      if (e.candidate) wsSend({ type: 'ice_candidate', payload: { callId, toUserId: remoteId, candidate: e.candidate.toJSON() } });
    };
    pc.ontrack = (e) => {
      if (e.streams[0]) this.events.onTrack(remoteId, e.streams[0]);
    };
    pc.onconnectionstatechange = () => this.events.onState(remoteId, pc.connectionState);
    return pc;
  }

  // ---- 1:1 ----

  async startCall(remoteId: string, kind: 'audio' | 'video'): Promise<string> {
    const callId = crypto.randomUUID();
    const pc = this.newPeer(remoteId, callId);
    pc.createDataChannel('presence'); // guarantees ICE runs even with no media tracks
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    wsSend({ type: 'webrtc_offer', payload: { callId, toUserId: remoteId, kind, sdp: offer.sdp! } });
    return callId;
  }

  async acceptCall(remoteId: string, callId: string, sdp: string): Promise<void> {
    const pc = this.newPeer(remoteId, callId);
    await pc.setRemoteDescription({ type: 'offer', sdp });
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    wsSend({ type: 'webrtc_answer', payload: { callId, toUserId: remoteId, sdp: answer.sdp! } });
  }

  // ---- room mesh ----

  async joinRoomMesh(roomId: string, existingPeers: { userId: string }[]): Promise<void> {
    this.roomId = roomId;
    // Joiner offers to everyone already present.
    for (const peer of existingPeers) {
      const callId = crypto.randomUUID();
      const pc = this.newPeer(peer.userId, callId);
      pc.createDataChannel('presence');
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      wsSend({ type: 'webrtc_offer', payload: { callId, toUserId: peer.userId, kind: 'video', roomId, sdp: offer.sdp! } });
    }
  }

  // ---- signaling dispatch ----

  private async onSignal(e: S2CEvent): Promise<void> {
    if (e.type === 'webrtc_offer' && e.payload.roomId && e.payload.roomId === this.roomId) {
      // Mesh auto-accept (see class comment).
      await this.acceptCall(e.payload.fromUserId!, e.payload.callId, e.payload.sdp);
      return;
    }
    if (e.type === 'webrtc_answer') {
      const pc = this.peers.get(e.payload.fromUserId!);
      if (pc && this.callIds.get(e.payload.fromUserId!) === e.payload.callId) {
        await pc.setRemoteDescription({ type: 'answer', sdp: e.payload.sdp });
      }
      return;
    }
    if (e.type === 'ice_candidate') {
      const pc = this.peers.get(e.payload.fromUserId!);
      if (pc) {
        try {
          await pc.addIceCandidate(e.payload.candidate as RTCIceCandidateInit);
        } catch {
          /* candidate for a closed pc — harmless */
        }
      }
      return;
    }
    if (e.type === 'call_hangup') {
      this.closePeer(e.payload.fromUserId!);
      return;
    }
    if (e.type === 'room_peer_left' && e.payload.roomId === this.roomId) {
      this.closePeer(e.payload.userId);
    }
  }

  closePeer(remoteId: string): void {
    this.peers.get(remoteId)?.close();
    this.peers.delete(remoteId);
    this.callIds.delete(remoteId);
    this.events.onState(remoteId, 'closed');
  }

  hangupAll(): void {
    for (const [remoteId] of this.peers) {
      const callId = this.callIds.get(remoteId)!;
      wsSend({ type: 'call_hangup', payload: { callId, toUserId: remoteId } });
      this.closePeer(remoteId);
    }
  }

  toggleMute(): boolean {
    const track = this.local?.getAudioTracks()[0];
    if (!track) return false;
    track.enabled = !track.enabled;
    return !track.enabled;
  }

  destroy(): void {
    this.hangupAll();
    this.unsub?.();
    this.local?.getTracks().forEach((t) => t.stop());
    this.local = null;
    this.events.onLocalStream(null);
  }
}
