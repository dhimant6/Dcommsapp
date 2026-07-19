import { api } from './api';

/**
 * Web Push enrolment — the browser-side half of push.service.ts.
 * Best-effort by design: no service worker (dev http), no PushManager (iOS
 * Safari not installed to home screen), or permission denied all mean "no
 * push", never a broken app. Safe to call on every launch — subscribe() with
 * the same key returns the existing subscription, and re-POSTing it is
 * idempotent server-side.
 */
export async function enablePush(): Promise<void> {
  try {
    if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return;
    const reg = await navigator.serviceWorker.ready;
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') return;
    const { publicKey } = await api<{ publicKey: string }>('GET', '/api/push/vapid-public-key');
    const subscription = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    });
    await api('POST', '/api/push/subscribe', { subscription: subscription.toJSON() });
  } catch {
    // Push is an enhancement; failures must never surface as app errors.
  }
}

function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}
