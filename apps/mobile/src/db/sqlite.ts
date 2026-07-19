import * as SQLite from 'expo-sqlite';

/**
 * OFFLINE-FIRST CACHE â€” the local mirror of the server's messages table.
 *
 * WHY expo-sqlite (not WatermelonDB): WatermelonDB is the better *product*
 * choice at scale (lazy loading, reactive queries via JSI), but it requires a
 * custom dev client build (no Expo Go) and its own model layer. expo-sqlite
 * keeps the sync logic VISIBLE â€” which is the thing we're here to learn.
 * Migration path exists if list perf ever hurts.
 *
 * SYNC MODEL (the whole strategy in four rules):
 *  1. UI reads ONLY from SQLite. Never render from a fetch response directly.
 *  2. Network writes INTO SQLite (REST sync + live WS events both upsert here).
 *  3. Outbound messages are INSERTed as status='pending' first (optimistic UI),
 *     flipped by acks, re-sent from here after reconnect.
 *  4. Sync cursor = MAX(created_at) per conversation â†’ REST ?since=. Idempotent:
 *     re-running a sync upserts the same rows harmlessly.
 */

let db: SQLite.SQLiteDatabase | null = null;

export async function getDb(): Promise<SQLite.SQLiteDatabase> {
  if (db) return db;
  db = await SQLite.openDatabaseAsync('dcom.db');
  await db.execAsync(`
    PRAGMA journal_mode = WAL;  -- readers don't block the writer: the chat list
                                -- can render while a sync batch is inserting

    CREATE TABLE IF NOT EXISTS conversations (
      id            TEXT PRIMARY KEY,
      kind          TEXT NOT NULL,
      title         TEXT,
      last_msg_at   INTEGER,            -- denormalized for ORDER BY in the list
      unread_count  INTEGER NOT NULL DEFAULT 0,
      preview       TEXT NOT NULL DEFAULT ''  -- denormalized last-message line
    );

    CREATE TABLE IF NOT EXISTS messages (
      -- client_msg_id is the PK because it exists BEFORE the server assigns an
      -- id (optimistic insert). server_id backfills when send_ack arrives.
      client_msg_id  TEXT PRIMARY KEY,
      server_id      TEXT UNIQUE,
      conversation_id TEXT NOT NULL,
      sender_id      TEXT NOT NULL,
      type           TEXT NOT NULL,
      content        TEXT NOT NULL,      -- JSON string, mirrors server JSONB
      created_at     INTEGER NOT NULL,   -- server time once acked; local until then
      status         TEXT NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending','sent','delivered','read'))
    );
    CREATE INDEX IF NOT EXISTS idx_msg_conv_time
      ON messages(conversation_id, created_at DESC);

    -- Sync cursors, one per conversation: "I have everything up to T".
    CREATE TABLE IF NOT EXISTS sync_state (
      conversation_id TEXT PRIMARY KEY,
      synced_until    INTEGER NOT NULL DEFAULT 0
    );
  `);
  return db;
}

