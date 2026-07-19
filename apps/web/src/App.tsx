import { useEffect, useState } from 'react';
import { restoreSession } from './api';
import { wsConnect } from './socket';
import { useStore } from './store';
import { Login } from './views/Login';
import { ChatPage } from './views/ChatPage';
import { RoomPage } from './views/RoomPage';

/**
 * Two personalities, one app:
 *   #/chat — personal mode (WhatsApp shape)
 *   #/room — MTR kiosk mode (a dedicated device in a meeting room)
 * Hash routing on purpose: a kiosk device is provisioned by bookmarking
 * "https://host/#/room" — no server routing, survives static hosting.
 */
function useHashRoute(): string {
  const [hash, setHash] = useState(location.hash || '#/chat');
  useEffect(() => {
    const onChange = () => setHash(location.hash || '#/chat');
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return hash;
}

export function App() {
  const user = useStore((s) => s.user);
  const [booting, setBooting] = useState(true);
  const route = useHashRoute();

  useEffect(() => {
    // Cold start: refresh-token → session, then open pipe 1.
    void restoreSession()
      .then((u) => {
        if (u) {
          useStore.getState().set({ user: u });
          wsConnect();
        }
      })
      .finally(() => setBooting(false));
  }, []);

  if (booting) return <div className="center-page">Loading…</div>;
  if (!user) return <Login roomMode={route.startsWith('#/room')} />;
  return route.startsWith('#/room') ? <RoomPage /> : <ChatPage />;
}
