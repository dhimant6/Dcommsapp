import type { ChatMessageRecv, MsgType } from '@dcom/shared';
import { getDb } from './sqlite';

/**
 * Repository over the SQLite cache — the ONLY module that writes chat rows.
 * Screens read through here and re-render via the change notifier below;
 * network code (REST sync + WS events) writes through here. That indirection
 * IS sync-rule #1/#2: UI reads only SQLite, network writes only SQLite.
 *
 * The notifier is deliberately coarse (one "something changed" signal, no
 * per-row granularity): screens re-query, and SQLite reads of a few hundred
 * rows are sub-millisecond. Reactive per-query invalidation is what the
 * WatermelonDB migration buys if this ever hurts.
 */

export interface ConvRow {
  id: string;
  kind: 'direct' | 'group';
  title: string;
  last_msg_at: number | null;
  unread_count: number;
  preview: string;
}

export interface MsgRow {
  client_msg_id: string;
  server_id: string | null;
  conversation_id: string;
  sender_id: string;
  type: MsgType;
  content: string; // JSON string, mirrors server JSONB
  created_at: number;
  status: 'pending' | 'sent' | 'delivered' | 'read';
}

const listeners = new Set<() => void>();

export function onChatDbChange(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

function notify(): void {
  listeners.forEach((l) => l());
}

// ---------- conversations ----------

export async function upsertConversation(c: {
  id: string;
  kind: string;
  title: string;
  lastMsgAt: number | null;
  unread: number;
  preview: string;
}): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    `INSERT INTO conversations (id, kind, title, last_msg_at, unread_count, preview)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       title = excluded.title,
       last_msg_at = COALESCE(excluded.last_msg_at, conversations.last_msg_at),
       unread_count = excluded.unread_count,
       preview = excluded.preview`,
    [c.id, c.kind, c.title, c.lastMsgAt, c.unread, c.preview],
  );
  notify();
}

export async function listConversations(): Promise<ConvRow[]> {
  const db = await getDb();
  return db.getAllAsync<ConvRow>(
    `SELECT * FROM conversations ORDER BY COALESCE(last_msg_at, 0) DESC`,
  );
}

export async function bumpConversation(convId: string, at: number, preview: string, incUnread: boolean): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    `UPDATE conversations SET last_msg_at = MAX(COALESCE(last_msg_at, 0), ?), preview = ?,
       unread_count = unread_count + ? WHERE id = ?`,
    [at, preview, incUnread ? 1 : 0, convId],
  );
  notify();
}

export async function clearUnread(convId: string): Promise<void> {
  const db = await getDb();
  await db.runAsync(`UPDATE conversations SET unread_count = 0 WHERE id = ?`, [convId]);
  notify();
}

// ---------- messages ----------

/** Server-authored rows (REST sync page or live WS event). Idempotent by
 *  construction — the same message arriving via both paths merges into one
 *  row, which is the client half of exactly-once delivery. */
export async function upsertServerMessage(m: ChatMessageRecv, status: MsgRow['status']): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    `INSERT INTO messages (client_msg_id, server_id, conversation_id, sender_id, type, content, created_at, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(client_msg_id) DO UPDATE SET
       server_id = excluded.server_id,
       created_at = excluded.created_at,
       -- never regress a status (a 'read' row must not go back to 'delivered')
       status = CASE WHEN messages.status IN ('read') THEN messages.status ELSE excluded.status END`,
    [m.clientMsgId, m.serverMsgId, m.conversationId, m.senderId, m.msgType, JSON.stringify(m.content), m.createdAt, status],
  );
  notify();
}

/** Optimistic send, sync-rule #3: the row exists BEFORE the network is asked. */
export async function insertPending(m: {
  clientMsgId: string;
  conversationId: string;
  senderId: string;
  msgType: MsgType;
  content: unknown;
}): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    `INSERT OR IGNORE INTO messages (client_msg_id, conversation_id, sender_id, type, content, created_at, status)
     VALUES (?, ?, ?, ?, ?, ?, 'pending')`,
    [m.clientMsgId, m.conversationId, m.senderId, m.msgType, JSON.stringify(m.content), Date.now()],
  );
  notify();
}

/** send_ack: backfill the server id, adopt server time, pending → sent. */
export async function ackSent(clientMsgId: string, serverMsgId: string, createdAt: number): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    `UPDATE messages SET server_id = ?, created_at = ?,
       status = CASE WHEN status = 'pending' THEN 'sent' ELSE status END
     WHERE client_msg_id = ?`,
    [serverMsgId, createdAt, clientMsgId],
  );
  notify();
}

const RANK = { pending: 0, sent: 1, delivered: 2, read: 3 } as const;

export async function markStatuses(serverIds: string[], status: 'delivered' | 'read'): Promise<void> {
  if (!serverIds.length) return;
  const db = await getDb();
  const marks = serverIds.map(() => '?').join(',');
  // Rank guard in SQL: only upgrade, never downgrade (acks can arrive out of order).
  await db.runAsync(
    `UPDATE messages SET status = ? WHERE server_id IN (${marks})
       AND CASE status WHEN 'pending' THEN 0 WHEN 'sent' THEN 1 WHEN 'delivered' THEN 2 ELSE 3 END < ?`,
    [status, ...serverIds, RANK[status]],
  );
  notify();
}

export async function listMessages(convId: string, limit = 100): Promise<MsgRow[]> {
  const db = await getDb();
  // Newest first — feeds an inverted FlatList directly.
  return db.getAllAsync<MsgRow>(
    `SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at DESC LIMIT ?`,
    [convId, limit],
  );
}

/** Sync-rule #3's second half: what to replay after a reconnect. */
export async function pendingMessages(): Promise<MsgRow[]> {
  const db = await getDb();
  return db.getAllAsync<MsgRow>(`SELECT * FROM messages WHERE status = 'pending' ORDER BY created_at ASC`);
}

/** Received rows not yet read-acked for a conversation (open-the-chat batch ack). */
export async function unreadServerIds(convId: string, myUserId: string): Promise<string[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<{ server_id: string }>(
    `SELECT server_id FROM messages WHERE conversation_id = ? AND sender_id <> ? AND server_id IS NOT NULL`,
    [convId, myUserId],
  );
  return rows.map((r) => r.server_id);
}

// ---------- sync cursors (rule #4) ----------

export async function getSyncCursor(convId: string): Promise<number> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ synced_until: number }>(
    `SELECT synced_until FROM sync_state WHERE conversation_id = ?`,
    [convId],
  );
  return row?.synced_until ?? 0;
}

export async function setSyncCursor(convId: string, ts: number): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    `INSERT INTO sync_state (conversation_id, synced_until) VALUES (?, ?)
     ON CONFLICT(conversation_id) DO UPDATE SET synced_until = MAX(sync_state.synced_until, excluded.synced_until)`,
    [convId, ts],
  );
}
