-- ============================================================================
-- Dcom — PostgreSQL schema.
-- Applied by BOTH adapters: the embedded PGlite instance (no-Docker dev) and
-- real Postgres (docker-entrypoint-initdb.d in the containerized path).
--
-- PORTABILITY NOTE: no extensions, no gen_random_uuid() — the application
-- supplies UUIDs (crypto.randomUUID()). This keeps the schema byte-identical
-- across engines AND means the id exists BEFORE the insert, which the
-- optimistic-UI flow needs anyway.
--
-- DESIGN PRINCIPLE: Postgres holds only DURABLE state. Ephemeral state
-- (presence, typing, sessions, live room membership) lives behind the KV port
-- with TTLs — see infra/redis/KEYSPACE.md.
-- ============================================================================

CREATE TABLE IF NOT EXISTS users (
    id            TEXT PRIMARY KEY,
    phone_e164    VARCHAR(16) NOT NULL UNIQUE,
    display_name  VARCHAR(64) NOT NULL DEFAULT '',
    avatar_url    TEXT,
    -- MTR concept: a user row can represent a ROOM DEVICE account (the console
    -- in a meeting room signs in like a user, WhatsApp-Web-style, but flagged).
    -- This mirrors how Teams provisions "resource accounts" for MTR hardware.
    is_room_device BOOLEAN NOT NULL DEFAULT FALSE,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at    TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS devices (
    id            TEXT PRIMARY KEY,
    user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    platform      VARCHAR(10) NOT NULL CHECK (platform IN ('ios','android','web','room')),
    push_token    TEXT,
    last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_devices_user ON devices(user_id);

-- Refresh rotation families: each use mints a successor in the same family;
-- presenting a revoked/used token revokes the WHOLE family (theft detection).
-- Only SHA-256 hashes stored — a DB leak must not leak usable tokens.
CREATE TABLE IF NOT EXISTS refresh_tokens (
    id           TEXT PRIMARY KEY,
    user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_id    TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    token_hash   CHAR(64) NOT NULL UNIQUE,
    family       TEXT NOT NULL,
    expires_at   TIMESTAMPTZ NOT NULL,
    revoked_at   TIMESTAMPTZ,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_refresh_family ON refresh_tokens(family);

-- One table for direct and group chats: a direct chat is a group of exactly 2
-- with direct_key = 'uuidA:uuidB' (sorted) — UNIQUE makes "start chat" races
-- collapse into one thread at the DB level.
CREATE TABLE IF NOT EXISTS conversations (
    id           TEXT PRIMARY KEY,
    kind         VARCHAR(10) NOT NULL CHECK (kind IN ('direct','group')),
    title        VARCHAR(128),
    direct_key   VARCHAR(80) UNIQUE,
    created_by   TEXT REFERENCES users(id),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS conversation_members (
    conversation_id  TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role             VARCHAR(10) NOT NULL DEFAULT 'member' CHECK (role IN ('member','admin')),
    joined_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Read receipts as WATERMARKS, not per-message rows: 100-person group ×
    -- 10k messages would be 1M receipt rows. Live granularity flows as WS
    -- events; the DB stores "read everything up to here".
    last_read_message_id  TEXT,
    last_read_at          TIMESTAMPTZ,
    PRIMARY KEY (conversation_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_members_user ON conversation_members(user_id);

-- content JSONB: message SHAPE varies by type; the envelope is relational so
-- the hot query (history by conversation+time) stays indexed.
-- client_msg_id UNIQUE(sender_id, ...): the idempotency key that turns
-- at-least-once delivery into exactly-once storage.
CREATE TABLE IF NOT EXISTS messages (
    id               TEXT PRIMARY KEY,
    conversation_id  TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    sender_id        TEXT NOT NULL REFERENCES users(id),
    client_msg_id    TEXT NOT NULL,
    type             VARCHAR(16) NOT NULL,
    content          JSONB NOT NULL,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    delivered_at     TIMESTAMPTZ,
    deleted_at       TIMESTAMPTZ,
    UNIQUE (sender_id, client_msg_id)
);
CREATE INDEX IF NOT EXISTS idx_messages_conv_time ON messages(conversation_id, created_at DESC);

-- Mock-Twilio OTP store (hash + attempts; rows are short-lived).
CREATE TABLE IF NOT EXISTS otp_codes (
    phone_e164   VARCHAR(16) PRIMARY KEY,
    code_hash    CHAR(64) NOT NULL,
    attempts     SMALLINT NOT NULL DEFAULT 0,
    expires_at   TIMESTAMPTZ NOT NULL
);

-- MTR meetings: a joinable room with a human-typeable code (what the console
-- keypad enters). Durable so codes survive gateway restarts; live membership
-- is KV-only.
CREATE TABLE IF NOT EXISTS meetings (
    id               TEXT PRIMARY KEY,
    room_code        VARCHAR(12) NOT NULL UNIQUE,
    title            VARCHAR(128) NOT NULL,
    conversation_id  TEXT REFERENCES conversations(id) ON DELETE SET NULL,
    created_by       TEXT REFERENCES users(id),
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at       TIMESTAMPTZ NOT NULL
);
