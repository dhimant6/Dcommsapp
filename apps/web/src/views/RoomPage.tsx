import { FormEvent, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { wsSend } from '../socket';
import { RtcManager } from '../rtc';
import { RoomPeer } from '@dcom/shared';
import { useStore } from '../store';

/**
 * MTR kiosk mode — the "Teams Rooms" personality.
 *
 * A dedicated device (wall panel, room console, TV stick) boots to #/room and
 * lives on the HUB screen: clock, room name, join-by-code, one-tap new
 * meeting. Joining enters an SFU-shaped grid — except transport is the mesh
 * (fine to ~4 endpoints; LiveKit swaps in for scale, same room_* signaling).
 *
 * Design notes vs. personal mode:
 *  - No chat surface: room devices are meeting endpoints, not message readers.
 *  - Auto-answer semantics: joining a room IS consent; no per-peer ring.
 *  - Big targets, dark theme: this UI is read from across a conference table.
 */
export function RoomPage() {
  const room = useStore((s) => s.room);
  return <div className="kiosk-root">{room ? <InCall /> : <Hub />}</div>;
}

function Hub() {
  const user = useStore((s) => s.user)!;
  const [now, setNow] = useState(new Date());
  const [code, setCode] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 10_000);
    // Deep link support: #/room?code=XXXX-YYYY (from a chat "Join" chip).
    const m = location.hash.match(/code=([A-Za-z0-9-]+)/);
    if (m) join(m[1]);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const join = (roomCode: string) => {
    setError('');
    wsSend({ type: 'room_join', payload: { roomCode, displayName: user.displayName } });
    // ROOM_NOT_FOUND surfaces via the error frame; give it a beat to arrive.
    setTimeout(() => {
      if (!useStore.getState().room) setError('No meeting found for that code.');
    }, 1500);
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (code.trim()) join(code.trim());
  };

  const instant = async () => {
    const meeting = await api<any>('POST', '/api/meetings', { title: `${user.displayName} — instant meeting` });
    join(meeting.roomCode);
  };

  return (
    <div className="kiosk-hub">
      <div className="kiosk-clock">
        <div className="time">{now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div>
        <div className="date muted">{now.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })}</div>
        <div className="room-name">{user.displayName}</div>
      </div>
      <div className="kiosk-actions">
        <button className="kiosk-btn primary" onClick={() => void instant()}>▶ New meeting</button>
        <form onSubmit={submit} className="kiosk-join">
          <input
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            placeholder="Enter code e.g. ABCD-EFGH"
            className="kiosk-input"
          />
          <button className="kiosk-btn">Join</button>
        </form>
        {error && <p className="error">{error}</p>}
      </div>
    </div>
  );
}

function InCall() {
  const room = useStore((s) => s.room)!;
  const user = useStore((s) => s.user)!;
  const [rtc] = useState(
    () =>
      new RtcManager({
        onTrack: (uid, stream) => setStreams((s) => ({ ...s, [uid]: stream })),
        onState: (uid, st) => setStates((s) => ({ ...s, [uid]: st })),
        onLocalStream: (stream) => setLocal(stream),
      }),
  );
  const [streams, setStreams] = useState<Record<string, MediaStream>>({});
  const [states, setStates] = useState<Record<string, string>>({});
  const [local, setLocal] = useState<MediaStream | null>(null);
  const [muted, setMuted] = useState(false);
  const joinedPeersRef = useRef<RoomPeer[]>(room.peers);

  useEffect(() => {
    // Mesh bootstrap: offer to everyone who was here before us.
    void (async () => {
      await rtc.init('video');
      await rtc.joinRoomMesh(room.roomId, joinedPeersRef.current);
    })();
    return () => rtc.destroy();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const leave = () => {
    wsSend({ type: 'room_leave', payload: { roomId: room.roomId } });
    rtc.destroy();
    useStore.getState().set({ room: null });
    location.hash = '#/room';
  };

  const tiles = room.peers;
  const cols = Math.ceil(Math.sqrt(tiles.length + 1));

  return (
    <div className="kiosk-call">
      <header className="kiosk-call-header">
        <span>{room.title}</span>
        <span className="muted">code {room.roomCode} · {tiles.length + 1} in room</span>
      </header>
      <div className="tile-grid" style={{ gridTemplateColumns: `repeat(${cols}, 1fr)` }}>
        <Tile name={`${user.displayName} (you)`} stream={local} mutedVideo />
        {tiles.map((p) => (
          <Tile key={p.userId} name={p.displayName} stream={streams[p.userId] ?? null} state={states[p.userId]} />
        ))}
      </div>
      <footer className="kiosk-call-bar">
        <button className="kiosk-btn" onClick={() => setMuted(rtc.toggleMute())}>{muted ? '🔇 Unmute' : '🎙️ Mute'}</button>
        <button className="kiosk-btn danger" onClick={leave}>Leave</button>
      </footer>
    </div>
  );
}

function Tile({ name, stream, state, mutedVideo }: { name: string; stream: MediaStream | null; state?: string; mutedVideo?: boolean }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.srcObject = stream;
  }, [stream]);
  const hasVideo = stream?.getVideoTracks().some((t) => t.readyState === 'live') ?? false;
  return (
    <div className="tile">
      {hasVideo ? (
        <video ref={ref} autoPlay playsInline muted={mutedVideo} />
      ) : (
        <div className="tile-avatar">
          <div className="avatar big">{name.slice(0, 1).toUpperCase()}</div>
          {/* No camera ≠ not connected: audio/viewer participants are normal
              on room hardware. Connection state shows the mesh truth. */}
          <span className="muted">{state === 'connected' ? 'connected (no camera)' : (state ?? 'connecting…')}</span>
        </div>
      )}
      <span className="tile-name">{name}</span>
    </div>
  );
}
