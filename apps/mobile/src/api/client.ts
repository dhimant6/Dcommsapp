import { useAuthStore } from '../state/authStore';

/**
 * Minimal fetch wrapper (axios adds 30kb for features we don't need).
 *
 * Physical device note: 'localhost' on a phone is the PHONE. Use your dev
 * machine's LAN IP (and `adb reverse tcp:3000 tcp:3000` works for Android
 * emulators; iOS simulator shares the host network so localhost is fine there).
 */
const BASE_URL = 'http://localhost:3000';

async function request<T = any>(method: string, path: string, body?: unknown): Promise<{ data: T }> {
  const token = useAuthStore.getState().accessToken;
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  // Contract for the full implementation: on 401, run the refresh flow ONCE
  // (POST /auth/refresh with the SecureStore token, persist the rotated pair,
  // replay the original request). Concurrent 401s must share a single in-flight
  // refresh promise â€” otherwise parallel requests each burn a rotation and the
  // family-reuse detector logs you out. Built alongside the gateway auth module.
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return { data: (await res.json()) as T };
}

export const api = {
  get: <T = any>(path: string) => request<T>('GET', path),
  post: <T = any>(path: string, body?: unknown) => request<T>('POST', path, body),
  patch: <T = any>(path: string, body?: unknown) => request<T>('PATCH', path, body),
};

