import { useEffect, useRef, useState } from 'react';
import { wsSend } from '../socket';
import { RtcManager } from '../rtc';
import { useStore } from '../store';

/**
 * 1:1 call UI. Two entry paths converge on one RtcManager lifecycle:
 *  - outgoing: store.activeCall set with empty callId → init → startCall
 *  - incoming: store.incomingCall set (ring) → Accept → init → acceptCall
 */
export function CallOverlay() {
  const incoming = useStore((s) => s.incomingCall);
  const active = useStore((s) => s.activeCall);
  const [rtc, setRtc] = useState<RtcManager | null>(null);
  const [state, setState] = useState('idle');
  const [muted, setMuted] = useState(false);
  const [mediaNote, setMediaNote] = useState('');
  const localRef = useRef<HTMLVideoElement>(null);
  const remoteRef = useRef<HTMLVideoElement>(null);

  // "Video is blank" almost always means a device/permission problem on ONE
  // side, not a connection problem — say so instead of leaving a black tile.
  const describeLocal = (stream: MediaStream | null) => {
    if (!stream) setMediaNote('mic/camera unavailable — check browser permission (lock icon in the address bar)');
    else if (stream.getVideoTracks().length === 0 && (active?.kind === 'video' || incoming?.kind === 'video'))
      setMediaNote('no camera found/allowed — sending audio only');
    else setMediaNote('');
  };

  // Outgoing leg
  useEffect(() => {
    if (!active || active.callId !== '' || rtc) return;
    const mgr = new RtcManager({
      onTrack: (_uid, stream) => remoteRef.current && (remoteRef.current.srcObject = stream),
      onState: (_uid, st) => {
        setState(st);
        if (st === 'closed' || st === 'failed') endCall(mgr);
      },
      onLocalStream: (stream) => {
        if (localRef.current) localRef.current.srcObject = stream;
        describeLocal(stream);
      },
    });
    setRtc(mgr);
    void (async () => {
      await mgr.init(active.kind);
      const callId = await mgr.startCall(active.peerId, active.kind);
      useStore.getState().set({ activeCall: { ...active, callId } });
      setState('ringing');
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  const accept = async () => {
    if (!incoming) return;
    const mgr = new RtcManager({
      onTrack: (_uid, stream) => remoteRef.current && (remoteRef.current.srcObject = stream),
      onState: (_uid, st) => {
        setState(st);
        if (st === 'closed' || st === 'failed') endCall(mgr);
      },
      onLocalStream: (stream) => {
        if (localRef.current) localRef.current.srcObject = stream;
        describeLocal(stream);
      },
    });
    setRtc(mgr);
    await mgr.init(incoming.kind);
    await mgr.acceptCall(incoming.fromUserId, incoming.callId, incoming.sdp);
    useStore.getState().set({
      activeCall: { callId: incoming.callId, peerId: incoming.fromUserId, peerName: incoming.fromName, kind: incoming.kind },
      incomingCall: null,
    });
  };

  const decline = () => {
    if (!incoming) return;
    wsSend({ type: 'call_hangup', payload: { callId: incoming.callId, toUserId: incoming.fromUserId } });
    useStore.getState().set({ incomingCall: null });
  };

  const endCall = (mgr?: RtcManager | null) => {
    (mgr ?? rtc)?.destroy();
    setRtc(null);
    setState('idle');
    useStore.getState().set({ activeCall: null });
  };

  if (incoming && !active) {
    return (
      <div className="call-overlay ring">
        <div className="card">
          <h3>📞 {incoming.fromName}</h3>
          <p className="muted">incoming {incoming.kind} call</p>
          <div className="row">
            <button className="accept" onClick={() => void accept()}>Accept</button>
            <button className="danger" onClick={decline}>Decline</button>
          </div>
        </div>
      </div>
    );
  }

  if (!active) return null;

  return (
    <div className="call-overlay">
      <div className="call-stage">
        <video ref={remoteRef} autoPlay playsInline className="remote-video" />
        <video ref={localRef} autoPlay playsInline muted className="local-video" />
        {mediaNote && <div className="media-note">{mediaNote}</div>}
        <div className="call-bar">
          <span>{active.peerName} — {state}</span>
          <button className="small" onClick={() => rtc && setMuted(rtc.toggleMute())}>{muted ? '🔇' : '🎙️'}</button>
          <button className="danger" onClick={() => endCall()}>End</button>
        </div>
      </div>
    </div>
  );
}
