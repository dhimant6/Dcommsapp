import { create } from 'zustand';
import * as SecureStore from 'expo-secure-store';

/**
 * WHY ZUSTAND (vs Redux Toolkit): our global state is small (auth, socket
 * status, presence map) and message data lives in SQLite, not in a store.
 * Zustand gives selector-based subscriptions with zero boilerplate. RTK earns
 * its ceremony when you need middleware pipelines, devtools time-travel, or a
 * large team needing enforced structure â€” none apply here.
 *
 * TOKEN STORAGE: refresh token goes in SecureStore (Keychain/Keystore â€”
 * hardware-backed, survives app restarts). The access token stays IN MEMORY
 * only: it lives 15 minutes, so persisting it adds theft surface for zero UX
 * gain. On cold start we always run the refresh flow.
 */

interface AuthState {
  accessToken: string | null;
  userId: string | null;
  hydrating: boolean;
  signIn: (tokens: { access: string; refresh: string; userId: string }) => Promise<void>;
  setAccessToken: (access: string) => void;      // used by the refresh flow
  signOut: () => Promise<void>;
  hydrate: () => Promise<void>;                  // cold start: refresh â†’ access token
}

const REFRESH_KEY = 'dcom.refreshToken';

export const useAuthStore = create<AuthState>((set) => ({
  accessToken: null,
  userId: null,
  hydrating: true,

  signIn: async ({ access, refresh, userId }) => {
    await SecureStore.setItemAsync(REFRESH_KEY, refresh);
    set({ accessToken: access, userId, hydrating: false });
  },

  setAccessToken: (access) => set({ accessToken: access }),

  signOut: async () => {
    await SecureStore.deleteItemAsync(REFRESH_KEY);
    set({ accessToken: null, userId: null });
  },

  hydrate: async () => {
    const refresh = await SecureStore.getItemAsync(REFRESH_KEY);
    if (!refresh) {
      set({ hydrating: false });
      return;
    }
    // Contract: POST /auth/refresh with the stored token. On success the server
    // ROTATES it â€” we must persist the new refresh token before using the new
    // access token, or a crash between the two leaves us with a revoked token.
    // Implemented in src/api/client.ts (refreshSession) when the gateway lands.
    set({ hydrating: false });
  },
}));

