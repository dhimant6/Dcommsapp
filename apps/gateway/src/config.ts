import 'dotenv/config';
import * as path from 'path';

/**
 * All environment access happens HERE, once, at boot. Modules import `config`,
 * never process.env — so the full surface of external configuration is visible
 * in one file (12-factor: config in the environment, but typed and validated
 * at the edge).
 */
function req(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined) throw new Error(`Missing required env var ${name}`);
  return v;
}

export const config = {
  port: parseInt(req('PORT', '3000'), 10),

  /** 'embedded' = PGlite + in-memory KV + disk blobs (zero Docker).
   *  'external' = Postgres + Redis + S3/MinIO from docker-compose. */
  adapters: req('ADAPTERS', 'embedded') as 'embedded' | 'external',

  dataDir: path.resolve(req('DATA_DIR', './data')),

  jwtSecret: req('JWT_SECRET', 'dev-secret-change-me-32-bytes-minimum!!'),
  accessTtlMin: parseInt(req('JWT_ACCESS_TTL_MIN', '15'), 10),
  refreshTtlDays: parseInt(req('REFRESH_TTL_DAYS', '30'), 10),

  otpMode: req('OTP_MODE', 'mock') as 'mock' | 'twilio',

  /** Demo gate: when set, signing in additionally requires this shared access
   *  code. Because OTP_MODE=mock returns codes to anyone, a public deployment
   *  would otherwise let strangers impersonate any phone number. The gate
   *  turns "public demo" into "invite-only demo" with one env var. */
  gateCode: process.env.GATE_CODE || undefined,

  databaseUrl: process.env.DATABASE_URL,
  redisUrl: process.env.REDIS_URL,

  s3: {
    endpoint: process.env.S3_ENDPOINT,
    bucket: process.env.S3_BUCKET ?? 'media',
    accessKey: process.env.S3_ACCESS_KEY,
    secretKey: process.env.S3_SECRET_KEY,
  },

  ice: {
    stunUrl: process.env.STUN_URL || undefined,
    turnUrl: process.env.TURN_URL || undefined,
    turnUser: process.env.TURN_USER || undefined,
    turnPass: process.env.TURN_PASS || undefined,
  },
};
