import { Injectable, Logger } from '@nestjs/common';

/**
 * Push notifications — FCM stub with the full production contract.
 *
 * WHEN IT FIRES: ws.service consults presence BEFORE fan-out; a member with no
 * live socket gets a push instead of a WS frame. That decision point ("is the
 * user reachable on pipe 1?") is the entire architecture of push — FCM itself
 * is just an HTTP call.
 *
 * PRODUCTION IMPLEMENTATION (drop-in, ~30 lines):
 *  1. Firebase project → service account JSON → FCM_SERVICE_ACCOUNT_JSON_PATH.
 *  2. `npm i firebase-admin`; init messaging() with the service account.
 *  3. Look up devices.push_token for the user (all devices, not one).
 *  4. messaging().sendEachForMulticast({ tokens, notification: {title, body},
 *     data: { conversationId } })  ← data payload lets the app deep-link.
 *  5. Prune tokens FCM reports as 'unregistered' (users reinstall constantly).
 * iOS: APNs key uploaded to Firebase; FCM proxies to APNs — no separate code.
 */
@Injectable()
export class PushService {
  private log = new Logger('Push');

  async notifyOffline(userId: string, preview: { title: string; body: string; conversationId: string }): Promise<void> {
    this.log.debug(`[push→${userId.slice(0, 8)}] ${preview.title}: ${preview.body}`);
  }
}
