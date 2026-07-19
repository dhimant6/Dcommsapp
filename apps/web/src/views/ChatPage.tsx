import { FormEvent, useEffect, useRef, useState } from 'react';
import { api, uploadMedia } from '../api';
import { wsSend } from '../socket';
import { Conv, UiMessage, useStore } from '../store';
import { CallOverlay } from './CallOverlay';

/** WhatsApp-shaped personal mode: sidebar + thread + composer. */
export function ChatPage() {
  const s = useStore();
  const [showNewChat, setShowNewChat] = useState(false);

  useEffect(() => {
    void api<Conv[]>('GET', '/api/conversations').then((convs) => {
      useStore.getState().set({ conversations: convs });
      // Presence snapshot for everyone in the sidebar; deltas arrive via WS.
      const ids = new Set<string>();
      convs.forEach((c) => (c.members ?? []).forEach((m) => m.id !== s.user!.id && ids.add(m.id)));
      if (ids.size) {
        void api<any>('GET', `/api/presence?ids=${[...ids].join(',')}`).then((p) =>
          useStore.getState().set({ presence: p }),
        );
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const active = s.conversations.find((c) => c.id === s.activeConvId) ?? null;

  return (
    <div className="chat-layout">
      <aside className="sidebar">
        <header className="sidebar-header">
          <div>
            <strong>{s.user!.displayName}</strong>
            <span className={`ws-dot ${s.wsStatus}`} title={`socket: ${s.wsStatus}`} />
          </div>
          <button className="small" onClick={() => setShowNewChat(true)}>+ New</button>
        </header>
        <div className="conv-list">
          {s.conversations.map((c) => (
            <ConvRow key={c.id} conv={c} />
          ))}
          {s.conversations.length === 0 && <p className="muted pad">No chats yet — start one with “+ New”.</p>}
        </div>
      </aside>
      {active ? <Thread conv={active} /> : <div className="thread empty muted">Select a conversation</div>}
      {showNewChat && <NewChatModal onClose={() => setShowNewChat(false)} />}
      <CallOverlay />
    </div>
  );
}

function safeParse(s: string): any {
  try {
    return JSON.parse(s);
  } catch {
    return { body: s };
  }
}

function ConvRow({ conv }: { conv: Conv }) {
  const s = useStore();
  const peer = conv.kind === 'direct' ? (conv.members ?? []).find((m) => m.id !== s.user!.id) : null;
  const online = peer && s.presence[peer.id]?.status === 'online';
  const preview = conv.lastMessage
    ? conv.lastMessage.type === 'text'
      ? (conv.lastMessage.content?.body ?? '')
      : `[${conv.lastMessage.type}]`
    : '';
  return (
    <div
      className={`conv-row ${s.activeConvId === conv.id ? 'active' : ''}`}
      onClick={() => useStore.getState().set({ activeConvId: conv.id })}
    >
      <div className="avatar">{(conv.title ?? '?').slice(0, 1).toUpperCase()}{online && <span className="online-dot" />}</div>
      <div className="conv-meta">
        <div className="conv-title">{conv.title}</div>
        <div className="conv-preview muted">{preview}</div>
      </div>
      {conv.unread > 0 && <span className="badge">{conv.unread}</span>}
    </div>
  );
}

function Thread({ conv }: { conv: Conv }) {
  const s = useStore();
  const msgs = s.messages[conv.id] ?? [];
  const bottomRef = useRef<HTMLDivElement>(null);
  const members = conv.members ?? [];
  const peer = conv.kind === 'direct' ? members.find((m) => m.id !== s.user!.id) : null;
  const presence = peer ? s.presence[peer.id] : null;
  const typingNames = Object.entries(s.typing[conv.id] ?? {})
    .filter(([, until]) => until > Date.now())
    .map(([uid]) => members.find((m) => m.id === uid)?.displayName ?? '');

  useEffect(() => {
    // Open a page of history, then read-ack what we received (batched — one
    // frame for the whole page, the receipt-batching the protocol was built for).
    void api<any[]>('GET', `/api/conversations/${conv.id}/messages`).then((history) => {
      const st = useStore.getState();
      for (const m of history) st.addMessage(conv.id, { ...m, status: m.senderId === st.user!.id ? 'sent' : 'delivered' });
      const unreadIds = history.filter((m) => m.senderId !== st.user!.id).map((m) => m.serverMsgId);
      if (unreadIds.length) {
        wsSend({ type: 'delivery_ack', payload: { conversationId: conv.id, messageIds: unreadIds } });
        wsSend({ type: 'read_ack', payload: { conversationId: conv.id, messageIds: unreadIds } });
      }
      st.upsertConv({ ...conv, unread: 0 });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conv.id]);

  // Braces matter: an implicit-return arrow would hand scrollIntoView's return
  // value to React as the effect "cleanup". Natively that's undefined (fine),
  // but smooth-scroll browser EXTENSIONS patch scrollIntoView to return a
  // Promise — and React then crashes calling it ("n is not a function", the
  // blank-page bug). Never implicit-return from useEffect.
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [msgs.length]);

  // Focus-to-read: messages that arrived while this tab was hidden were only
  // delivery-acked (socket.ts gates read_ack on visibility). Coming back to
  // the tab is the "human saw it" moment — re-ack everything from others.
  // Re-sending already-read ids is harmless: the watermark is idempotent.
  useEffect(() => {
    const ackVisible = () => {
      if (document.visibilityState !== 'visible') return;
      const st = useStore.getState();
      const ids = (st.messages[conv.id] ?? [])
        .filter((m) => m.senderId !== st.user!.id && m.serverMsgId)
        .map((m) => m.serverMsgId);
      if (ids.length) wsSend({ type: 'read_ack', payload: { conversationId: conv.id, messageIds: ids } });
    };
    document.addEventListener('visibilitychange', ackVisible);
    window.addEventListener('focus', ackVisible);
    return () => {
      document.removeEventListener('visibilitychange', ackVisible);
      window.removeEventListener('focus', ackVisible);
    };
  }, [conv.id]);

  const startCall = (kind: 'audio' | 'video') => {
    if (!peer) return;
    useStore.getState().set({ activeCall: { callId: '', peerId: peer.id, peerName: peer.displayName, kind } });
  };

  const startMeeting = async () => {
    const meeting = await api<any>('POST', '/api/meetings', { title: `${conv.title} meeting`, conversationId: conv.id });
    sendMessage(conv.id, 'meeting', { body: `Meeting started — code ${meeting.roomCode}`, roomCode: meeting.roomCode });
  };

  return (
    <main className="thread">
      <header className="thread-header">
        <div>
          <strong>{conv.title}</strong>
          <div className="muted small-text">
            {typingNames.length
              ? `${typingNames.join(', ')} typing…`
              : presence
                ? presence.status === 'online'
                  ? 'online'
                  : presence.lastSeenAt
                    ? `last seen ${new Date(presence.lastSeenAt).toLocaleTimeString()}`
                    : 'offline'
                : `${members.length} members`}
          </div>
        </div>
        <div className="thread-actions">
          {peer && <button className="small" onClick={() => startCall('audio')}>📞</button>}
          {peer && <button className="small" onClick={() => startCall('video')}>🎥</button>}
          <button className="small" onClick={() => void startMeeting()}>📺 Meet</button>
        </div>
      </header>
      <div className="msg-scroll">
        {msgs.map((m) => (
          <Bubble key={m.clientMsgId} m={m} own={m.senderId === s.user!.id} group={conv.kind === 'group'} />
        ))}
        <div ref={bottomRef} />
      </div>
      <Composer convId={conv.id} />
    </main>
  );
}

function Bubble({ m, own, group }: { m: UiMessage; own: boolean; group: boolean }) {
  const ticks = own ? (m.status === 'read' ? '✓✓' : m.status === 'delivered' ? '✓✓' : m.status === 'sent' ? '✓' : '🕐') : '';
  // Never trust a single message's shape enough to let it crash the page — a
  // malformed row should render as an empty bubble, not a blank app.
  const content = (typeof m.content === 'string' ? safeParse(m.content) : m.content) ?? {};
  return (
    <div className={`bubble ${own ? 'own' : ''}`}>
      {group && !own && <div className="sender">{m.senderName}</div>}
      {m.msgType === 'image' && content.url && <img src={content.url} alt="" className="msg-img" />}
      {m.msgType === 'meeting' ? (
        <div className="meeting-chip">
          📺 {content.body}
          <a href={`#/room?code=${content.roomCode}`}> Join</a>
        </div>
      ) : (
        content.body && <span>{content.body}</span>
      )}
      <span className={`ticks ${m.status === 'read' ? 'read' : ''}`}>
        {new Date(m.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} {ticks}
      </span>
    </div>
  );
}

/** Optimistic send: message hits the store as 'pending' BEFORE the network —
 *  UI latency is zero; acks upgrade the status. */
export function sendMessage(convId: string, msgType: UiMessage['msgType'], content: UiMessage['content']) {
  const st = useStore.getState();
  const clientMsgId = crypto.randomUUID();
  st.addMessage(convId, {
    clientMsgId,
    serverMsgId: '',
    conversationId: convId,
    senderId: st.user!.id,
    senderName: st.user!.displayName,
    msgType,
    content,
    createdAt: Date.now(),
    status: 'pending',
  });
  wsSend({ type: 'chat_message', payload: { clientMsgId, conversationId: convId, msgType, content } });
}

function Composer({ convId }: { convId: string }) {
  const [text, setText] = useState('');
  const lastTypingSent = useRef(0);
  const fileRef = useRef<HTMLInputElement>(null);

  const onType = (v: string) => {
    setText(v);
    // Throttle: at most one typing frame per 4s (server TTL is 6s).
    if (Date.now() - lastTypingSent.current > 4000) {
      lastTypingSent.current = Date.now();
      wsSend({ type: 'typing', payload: { conversationId: convId, isTyping: true } });
    }
  };

  const send = (e: FormEvent) => {
    e.preventDefault();
    if (!text.trim()) return;
    sendMessage(convId, 'text', { body: text.trim() });
    setText('');
  };

  const attach = async (file: File) => {
    const { publicUrl, mime, size } = await uploadMedia(file);
    sendMessage(convId, 'image', { url: publicUrl, mime, size });
  };

  return (
    <form className="composer" onSubmit={send}>
      <button type="button" className="small" onClick={() => fileRef.current?.click()}>📎</button>
      <input type="file" accept="image/*" hidden ref={fileRef} onChange={(e) => e.target.files?.[0] && void attach(e.target.files[0])} />
      <input value={text} onChange={(e) => onType(e.target.value)} placeholder="Type a message" />
      <button disabled={!text.trim()}>Send</button>
    </form>
  );
}

function NewChatModal({ onClose }: { onClose: () => void }) {
  const [phone, setPhone] = useState('+91');
  const [error, setError] = useState('');

  const create = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const conv = await api<Conv>('POST', '/api/conversations/direct', { peerPhone: phone });
      useStore.getState().upsertConv(conv);
      useStore.getState().set({ activeConvId: conv.id });
      onClose();
    } catch (err: any) {
      setError(err.message);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="card" onClick={(e) => e.stopPropagation()}>
        <h3>Start a chat</h3>
        <form onSubmit={create}>
          <label>Their phone number</label>
          <input value={phone} onChange={(e) => setPhone(e.target.value)} autoFocus />
          <button>Start</button>
        </form>
        {error && <p className="error">{error}</p>}
      </div>
    </div>
  );
}
