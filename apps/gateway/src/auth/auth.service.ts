import { BadRequestException, Inject, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import * as crypto from 'crypto';
import { TokenPair } from '@dcom/shared';
import { config } from '../config';
import { DB, KV, DbPort, KvPort } from '../ports/ports';
import { TokensService } from './tokens.service';

const uuid = () => crypto.randomUUID();

/**
 * Phone-OTP auth (mock Twilio) + refresh-token rotation.
 *
 * FLOW: request → 6-digit code stored HASHED with 5-min expiry (rate-limited
 * in KV: 3 requests / 10 min / phone). verify → user upserted by phone,
 * device row created, token pair issued. refresh → rotation with family
 * reuse-detection.
 */
@Injectable()
export class AuthService {
  private log = new Logger('Auth');

  constructor(
    @Inject(DB) private db: DbPort,
    @Inject(KV) private kv: KvPort,
    private tokens: TokensService,
  ) {}

  async requestOtp(phone: string): Promise<{ devCode?: string }> {
    if (!/^\+[1-9]\d{7,14}$/.test(phone)) throw new BadRequestException('phone must be E.164, e.g. +919876543210');

    const hits = await this.kv.incr(`rl:otp:${phone}`, 600);
    if (hits > 5) throw new BadRequestException('Too many OTP requests; wait 10 minutes');

    const code = String(crypto.randomInt(100000, 1000000));
    await this.db.query(
      `INSERT INTO otp_codes (phone_e164, code_hash, attempts, expires_at)
       VALUES ($1, $2, 0, now() + interval '5 minutes')
       ON CONFLICT (phone_e164) DO UPDATE SET code_hash = $2, attempts = 0, expires_at = now() + interval '5 minutes'`,
      [phone, this.tokens.hash(code)],
    );

    // Twilio integration point: this is the ONLY line that changes for real
    // SMS — messages.create({to: phone, body: `Dcom code: ${code}`}).
    this.log.log(`OTP for ${phone}: ${code}`);
    // Mock mode returns the code so the UI/tests can complete the loop without
    // reading server logs. NEVER in a real deployment.
    return config.otpMode === 'mock' ? { devCode: code } : {};
  }

  async verifyOtp(phone: string, code: string, platform: string, displayName?: string): Promise<TokenPair> {
    const { rows } = await this.db.query(
      `SELECT code_hash, attempts, expires_at FROM otp_codes WHERE phone_e164 = $1`,
      [phone],
    );
    const row = rows[0];
    const expired = !row || new Date(row.expires_at).getTime() < Date.now();
    if (expired || row.attempts >= 5 || row.code_hash !== this.tokens.hash(code)) {
      if (row) await this.db.query(`UPDATE otp_codes SET attempts = attempts + 1 WHERE phone_e164 = $1`, [phone]);
      throw new UnauthorizedException('Invalid or expired code');
    }
    await this.db.query(`DELETE FROM otp_codes WHERE phone_e164 = $1`, [phone]); // single-use

    // Upsert user by phone (first login = signup; the WhatsApp model).
    const name = displayName?.trim() || `User ${phone.slice(-4)}`;
    const userRes = await this.db.query(
      `INSERT INTO users (id, phone_e164, display_name) VALUES ($1, $2, $3)
       ON CONFLICT (phone_e164) DO UPDATE SET phone_e164 = EXCLUDED.phone_e164
       RETURNING id, phone_e164, display_name`,
      [uuid(), phone, name],
    );
    const user = userRes.rows[0];

    const deviceId = uuid();
    await this.db.query(`INSERT INTO devices (id, user_id, platform) VALUES ($1, $2, $3)`, [
      deviceId,
      user.id,
      ['ios', 'android', 'web', 'room'].includes(platform) ? platform : 'web',
    ]);

    return this.issuePair(user, deviceId, uuid() /* new rotation family */);
  }

  async refresh(refreshToken: string): Promise<TokenPair> {
    const hash = this.tokens.hash(refreshToken);
    const { rows } = await this.db.query(
      `SELECT rt.id, rt.user_id, rt.device_id, rt.family, rt.expires_at, rt.revoked_at,
              u.phone_e164, u.display_name
       FROM refresh_tokens rt JOIN users u ON u.id = rt.user_id
       WHERE rt.token_hash = $1`,
      [hash],
    );
    const row = rows[0];
    if (!row) throw new UnauthorizedException('Unknown refresh token');

    // REUSE DETECTION: a token that was already rotated (revoked_at set) is
    // being presented again → either a replayed steal or a client that lost
    // the rotation response. Both cases: revoke the entire family; every
    // device holding a descendant must re-authenticate. Security beats UX here.
    if (row.revoked_at) {
      await this.db.query(`UPDATE refresh_tokens SET revoked_at = now() WHERE family = $1 AND revoked_at IS NULL`, [
        row.family,
      ]);
      throw new UnauthorizedException('Refresh token reuse detected — family revoked');
    }
    if (new Date(row.expires_at).getTime() < Date.now()) throw new UnauthorizedException('Refresh token expired');

    await this.db.query(`UPDATE refresh_tokens SET revoked_at = now() WHERE id = $1`, [row.id]);
    return this.issuePair(
      { id: row.user_id, phone_e164: row.phone_e164, display_name: row.display_name },
      row.device_id,
      row.family,
    );
  }

  private async issuePair(
    user: { id: string; phone_e164: string; display_name: string },
    deviceId: string,
    family: string,
  ): Promise<TokenPair> {
    const refresh = this.tokens.newOpaqueToken();
    await this.db.query(
      `INSERT INTO refresh_tokens (id, user_id, device_id, token_hash, family, expires_at)
       VALUES ($1, $2, $3, $4, $5, now() + interval '${config.refreshTtlDays} days')`,
      [uuid(), user.id, deviceId, this.tokens.hash(refresh), family],
    );
    return {
      access: this.tokens.signAccess({ sub: user.id, dev: deviceId, name: user.display_name }),
      refresh,
      user: { id: user.id, phone: user.phone_e164, displayName: user.display_name },
    };
  }
}
