import type { TokenPair } from '@dcom/shared';

/**
 * Fetch wrapper with single-flight refresh.
 *
 * Access token: memory only (module variable) — 15-min lifetime, persisting it
 * would add theft surface for zero UX gain. Refresh token: localStorage (the
 * web trade-off; native apps use Keychain/Keystore — see mobile skeleton).
 *
 * SINGLE-FLIGHT: concurrent 401s share one refresh promise. Without this,
 * parallel requests each burn a rotation and the family-reuse detector — the
 * security feature — logs the user out. A correct client is part of the
 * rotation protocol, not an afterthought.
 */
let accessToken: string | null = null;
let refreshing: Promise<boolean> | null = null;

export const REFRESH_KEY = 'dcom.refresh';

export function setTokens(pair: TokenPair) {
  accessToken = pair.access;
  localStorage.setItem(REFRESH_KEY, pair.refresh);
}

export function clearTokens() {
  accessToken = null;
  localStorage.removeItem(REFRESH_KEY);
}

export function getAccessToken() {
  return accessToken;
}

async function refreshOnce(): Promise<boolean> {
  if (!refreshing) {
    refreshing = (async () => {
      const stored = localStorage.getItem(REFRESH_KEY);
      if (!stored) return false;
      const res = await fetch('/api/auth/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh: stored }),
      });
      if (!res.ok) {
        clearTokens();
        return false;
      }
      const pair = (await res.json()) as TokenPair;
      setTokens(pair);
      return true;
    })().finally(() => setTimeout(() => (refreshing = null), 0));
  }
  return refreshing;
}

/** Cold-start session restore: refresh → fresh access token. */
export async function restoreSession(): Promise<TokenPair['user'] | null> {
  const ok = await refreshOnce();
  if (!ok) return null;
  const me = await api<any>('GET', '/api/me');
  return { id: me.id, phone: me.phone, displayName: me.displayName };
}

export async function api<T = any>(method: string, path: string, body?: unknown, retried = false): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 401 && !retried && (await refreshOnce())) {
    return api<T>(method, path, body, true);
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message ?? `${res.status}`);
  }
  return res.json();
}

/** Media upload — the presign choreography (identical for disk and S3 modes). */
export async function uploadMedia(file: File): Promise<{ publicUrl: string; mime: string; size: number }> {
  const presign = await api<any>('POST', '/media/presign', { mime: file.type, size: file.size });
  const put = await fetch(presign.uploadUrl, { method: 'PUT', headers: presign.headers, body: file });
  if (!put.ok) throw new Error('upload failed');
  return { publicUrl: presign.publicUrl, mime: file.type, size: file.size };
}
