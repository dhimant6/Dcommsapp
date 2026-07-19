import { Injectable } from '@nestjs/common';
import * as jwt from 'jsonwebtoken';
import * as crypto from 'crypto';
import { config } from '../config';

export interface AccessClaims {
  sub: string;        // userId
  dev: string;        // deviceId
  name: string;
}

/**
 * Token mechanics, isolated from auth flow logic so the WS gateway can verify
 * access tokens without importing OTP/refresh machinery.
 *
 * ACCESS token: JWT, 15 min. Verified statelessly on every REST call and once
 * per WS upgrade — no DB hit, which is what keeps auth off the hot path.
 * REFRESH token: opaque 256-bit random, stored HASHED in Postgres, rotated on
 * every use (family revocation on reuse — see refresh_tokens table comment).
 * Different constructions because their threat models differ: access tokens
 * optimize verification cost, refresh tokens optimize revocability.
 */
@Injectable()
export class TokensService {
  signAccess(claims: AccessClaims): string {
    return jwt.sign(claims, config.jwtSecret, { expiresIn: `${config.accessTtlMin}m` });
  }

  verifyAccess(token: string): AccessClaims | null {
    try {
      return jwt.verify(token, config.jwtSecret) as unknown as AccessClaims;
    } catch {
      return null;
    }
  }

  newOpaqueToken(): string {
    return crypto.randomBytes(32).toString('base64url');
  }

  hash(value: string): string {
    return crypto.createHash('sha256').update(value).digest('hex');
  }
}
