import { Inject, Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import * as webpush from 'web-push';
import { config } from '../config';
import { DB, DbPort } from '../ports/ports';

/**
 * Push notifications, two halves:
 *
 * WHEN IT FIRES: ws.service consults presence BEFORE fan-out; a member with no
 * live socket gets a push instead of a WS frame. That decision point ("is the
 * user reachable on pipe 1?") is the entire architecture of push — the
 * transport below is just an HTTP call.
 *
 * TRANSPORT (implemented): Web Push (VAPID) to browser/PWA subscriptions
 * stored in devices.push_token. Payloads are a doorbell, not a mailbox — a
 * title/body preview plus the conversationId for deep-linking; message
 * recovery is always the client's REST ?since= sync.
 *
 * NATIVE FCM/APNs (when the mobile app ships): same table, same decision
 * point — store the FCM token in devices.push_token for platform ios/android
 * and call messaging().sendEachForMulticast instead of webpush.send.
 *
 * VAPID keys: VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY env if provided, else
 * generated once and persisted to DATA_DIR/vapid.json — push works with zero
 * setup locally, and survives restarts as long as the data dir does.
 */
@Injectable()
export class PushService {
  private log = new Logger('Push');
  readonly publicKey: string;

  constructor(@Inject(DB) private db: DbPort) {
    let pub = config.vapidPublicKey;
    let priv = config.vapidPrivateKey;
    if (!pub || !priv) {
      const file = path.join(config.dataDir, 'vapid.json');
      if (fs.existsSync(file)) {
        ({ publicKey: pub, privateKey: priv } = JSON.parse(fs.readFileSync(file, 'utf8')));
      } else {
        ({ publicKey: pub, privateKey: priv } = webpush.generateVAPIDKeys());
        fs.mkdirSync(config.dataDir, { recursive: true });
        fs.writeFileSync(file, JSON.stringify({ publicKey: pub, privateKey: priv }));
      }
    }
    this.publicKey = pub!;
    webpush.setVapidDetails('mailto:admin@dcom.example', pub!, priv!);
  }

  async saveSubscription(userId: string, deviceId: string, subscription: unknown): Promise<void> {
    await this.db.query(`UPDATE devices SET push_token = $1 WHERE id = $2 AND user_id = $3`, [
      JSON.stringify(subscription),
      deviceId,
      userId,
    ]);
  }

  async removeSubscription(userId: string, deviceId: string): Promise<void> {
    await this.db.query(`UPDATE devices SET push_token = NULL WHERE id = $1 AND user_id = $2`, [deviceId, userId]);
  }

  async notifyOffline(userId: string, preview: { title: string; body: string; conversationId: string }): Promise<void> {
    const { rows } = await this.db.query(
      `SELECT id, push_token FROM devices WHERE user_id = $1 AND push_token IS NOT NULL AND platform = 'web'`,
      [userId],
    );
    if (!rows.length) {
      this.log.debug(`[push→${userId.slice(0, 8)}] no subscriptions — ${preview.title}: ${preview.body}`);
      return;
    }
    await Promise.all(
      rows.map(async (d: any) => {
        try {
          await webpush.sendNotification(JSON.parse(d.push_token), JSON.stringify(preview), { TTL: 3600 });
        } catch (err: any) {
          // 404/410 = subscription is dead (user cleared site data, browser
          // rotated it). Prune — the client re-subscribes on next launch.
          if (err?.statusCode === 404 || err?.statusCode === 410) {
            await this.db.query(`UPDATE devices SET push_token = NULL WHERE id = $1`, [d.id]);
          } else {
            this.log.warn(`push to ${userId.slice(0, 8)} failed: ${err?.message ?? err}`);
          }
        }
      }),
    );
  }
}
