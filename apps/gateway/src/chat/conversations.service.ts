import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import * as crypto from 'crypto';
import { DB, DbPort } from '../ports/ports';

const uuid = () => crypto.randomUUID();

@Injectable()
export class ConversationsService {
  constructor(@Inject(DB) private db: DbPort) {}

  /** Membership check used by REST and by every WS frame router path.
   *  Authorization lives server-side per operation — the client's local list
   *  of conversations is a cache, never an authority. */
  async assertMember(conversationId: string, userId: string): Promise<void> {
    const { rows } = await this.db.query(
      `SELECT 1 FROM conversation_members WHERE conversation_id = $1 AND user_id = $2`,
      [conversationId, userId],
    );
    if (!rows[0]) throw new ForbiddenException('Not a member of this conversation');
  }

  async memberIds(conversationId: string): Promise<string[]> {
    const { rows } = await this.db.query(
      `SELECT user_id FROM conversation_members WHERE conversation_id = $1`,
      [conversationId],
    );
    return rows.map((r) => r.user_id);
  }

  /** Idempotent 1:1 creation. direct_key = sorted 'idA:idB'; the UNIQUE
   *  constraint collapses concurrent "start chat with X" races into one row —
   *  the DB enforces the invariant, not application locks. */
  async createDirect(meId: string, peerPhone: string) {
    const peer = (
      await this.db.query(`SELECT id, display_name FROM users WHERE phone_e164 = $1 AND deleted_at IS NULL`, [
        peerPhone,
      ])
    ).rows[0];
    if (!peer) throw new NotFoundException('No user with that phone number');
    if (peer.id === meId) throw new BadRequestException('That is your own number');

    const key = [meId, peer.id].sort().join(':');
    const existing = (await this.db.query(`SELECT id FROM conversations WHERE direct_key = $1`, [key])).rows[0];
    if (existing) return this.getSummary(existing.id, meId);

    const id = uuid();
    await this.db.query(
      `INSERT INTO conversations (id, kind, direct_key, created_by) VALUES ($1, 'direct', $2, $3)
       ON CONFLICT (direct_key) DO NOTHING`,
      [id, key, meId],
    );
    // Race lost? Someone else inserted the same pair between our SELECT and
    // INSERT — read back whichever row won.
    const conv = (await this.db.query(`SELECT id FROM conversations WHERE direct_key = $1`, [key])).rows[0];
    if (conv.id === id) {
      for (const uid of [meId, peer.id]) {
        await this.db.query(
          `INSERT INTO conversation_members (conversation_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [conv.id, uid],
        );
      }
    }
    return this.getSummary(conv.id, meId);
  }

  async createGroup(meId: string, title: string, memberPhones: string[]) {
    if (!title?.trim()) throw new BadRequestException('Group needs a title');
    const id = uuid();
    await this.db.query(`INSERT INTO conversations (id, kind, title, created_by) VALUES ($1, 'group', $2, $3)`, [
      id,
      title.trim(),
      meId,
    ]);
    await this.db.query(
      `INSERT INTO conversation_members (conversation_id, user_id, role) VALUES ($1, $2, 'admin')`,
      [id, meId],
    );
    for (const phone of memberPhones ?? []) {
      const u = (await this.db.query(`SELECT id FROM users WHERE phone_e164 = $1`, [phone])).rows[0];
      if (u && u.id !== meId) {
        await this.db.query(
          `INSERT INTO conversation_members (conversation_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [id, u.id],
        );
      }
    }
    return this.getSummary(id, meId);
  }

  /** Sidebar list: conversations + last message + unread count in ONE query
   *  per concern. The unread count compares against the member's watermark —
   *  this is where the watermark design pays for itself (no receipt-row scans). */
  async listForUser(meId: string) {
    const { rows } = await this.db.query(
      `SELECT c.id, c.kind, c.title, c.created_at,
              cm.last_read_message_id,
              lm.content AS last_content, lm.type AS last_type,
              lm.created_at AS last_msg_at, lu.display_name AS last_sender
       FROM conversation_members cm
       JOIN conversations c ON c.id = cm.conversation_id
       LEFT JOIN LATERAL (
         SELECT m.* FROM messages m
         WHERE m.conversation_id = c.id AND m.deleted_at IS NULL
         ORDER BY m.created_at DESC LIMIT 1
       ) lm ON TRUE
       LEFT JOIN users lu ON lu.id = lm.sender_id
       WHERE cm.user_id = $1
       ORDER BY COALESCE(lm.created_at, c.created_at) DESC`,
      [meId],
    );

    const result = [] as any[];
    for (const r of rows) {
      const members = await this.db.query(
        `SELECT u.id, u.display_name, u.phone_e164 FROM conversation_members cm
         JOIN users u ON u.id = cm.user_id WHERE cm.conversation_id = $1`,
        [r.id],
      );
      const unread = await this.db.query(
        `SELECT COUNT(*)::int AS n FROM messages m
         WHERE m.conversation_id = $1 AND m.sender_id <> $2 AND m.deleted_at IS NULL
           AND m.created_at > COALESCE(
             (SELECT created_at FROM messages WHERE id = $3), 'epoch'::timestamptz)`,
        [r.id, meId, r.last_read_message_id],
      );
      const peers = members.rows.filter((m: any) => m.id !== meId);
      result.push({
        id: r.id,
        kind: r.kind,
        // Direct chats have no stored title — derived from the peer, so a
        // display-name change never requires touching conversation rows.
        title: r.kind === 'direct' ? (peers[0]?.display_name ?? 'Unknown') : r.title,
        members: members.rows.map((m: any) => ({ id: m.id, displayName: m.display_name, phone: m.phone_e164 })),
        lastMessage: r.last_msg_at
          ? {
              type: r.last_type,
              // Defensive: JSONB normally arrives as an object, but never let a
              // driver quirk ship a raw string to clients expecting an object.
              content: typeof r.last_content === 'string' ? JSON.parse(r.last_content) : r.last_content,
              at: new Date(r.last_msg_at).getTime(),
              sender: r.last_sender,
            }
          : null,
        unread: unread.rows[0].n,
      });
    }
    return result;
  }

  async getSummary(conversationId: string, meId: string) {
    const all = await this.listForUser(meId);
    return all.find((c) => c.id === conversationId);
  }

  /** Message search, the honest small-scale version: ILIKE over the JSONB
   *  body, scoped to my conversations via the membership join (authorization
   *  and filtering in one clause). This is exactly the query the README says
   *  won't survive scale — the upgrade path is an async index (pg_trgm GIN
   *  first, then external search), same endpoint contract. */
  async search(meId: string, q: string, limit = 30) {
    const term = (q ?? '').trim();
    if (!term) return [];
    const pattern = '%' + term.replace(/[\\%_]/g, '\\$&') + '%';
    const { rows } = await this.db.query(
      `SELECT m.id, m.conversation_id, m.sender_id, m.content, m.created_at,
              u.display_name AS sender_name
       FROM messages m
       JOIN conversation_members cm ON cm.conversation_id = m.conversation_id AND cm.user_id = $1
       JOIN users u ON u.id = m.sender_id
       WHERE m.deleted_at IS NULL AND m.type = 'text'
         AND m.content->>'body' ILIKE $2
       ORDER BY m.created_at DESC LIMIT $3`,
      [meId, pattern, Math.min(Math.max(limit, 1), 100)],
    );
    return rows.map((m: any) => ({
      serverMsgId: m.id,
      conversationId: m.conversation_id,
      senderId: m.sender_id,
      senderName: m.sender_name,
      body: (typeof m.content === 'string' ? JSON.parse(m.content) : m.content)?.body ?? '',
      createdAt: new Date(m.created_at).getTime(),
    }));
  }

  /** THE offline-sync endpoint. `since` (ms) = newest message the client has;
   *  idempotent and resumable — the client can call it after every reconnect
   *  and duplicates are impossible by construction (upsert by id client-side). */
  async history(conversationId: string, meId: string, sinceMs?: number, beforeMs?: number, limit = 50) {
    await this.assertMember(conversationId, meId);
    const lim = Math.min(Math.max(limit, 1), 200);
    let rows;
    if (sinceMs) {
      rows = await this.db.query(
        `SELECT m.*, u.display_name AS sender_name FROM messages m JOIN users u ON u.id = m.sender_id
         WHERE m.conversation_id = $1 AND m.created_at > to_timestamp($2::double precision / 1000.0)
           AND m.deleted_at IS NULL
         ORDER BY m.created_at ASC LIMIT $3`,
        [conversationId, sinceMs, lim],
      );
    } else if (beforeMs) {
      // Scroll-up pagination: older pages.
      rows = await this.db.query(
        `SELECT m.*, u.display_name AS sender_name FROM messages m JOIN users u ON u.id = m.sender_id
         WHERE m.conversation_id = $1 AND m.created_at < to_timestamp($2::double precision / 1000.0)
           AND m.deleted_at IS NULL
         ORDER BY m.created_at DESC LIMIT $3`,
        [conversationId, beforeMs, lim],
      );
      rows.rows.reverse();
    } else {
      rows = await this.db.query(
        `SELECT m.*, u.display_name AS sender_name FROM messages m JOIN users u ON u.id = m.sender_id
         WHERE m.conversation_id = $1 AND m.deleted_at IS NULL
         ORDER BY m.created_at DESC LIMIT $2`,
        [conversationId, lim],
      );
      rows.rows.reverse();
    }
    return rows.rows.map((m: any) => ({
      serverMsgId: m.id,
      clientMsgId: m.client_msg_id,
      conversationId: m.conversation_id,
      senderId: m.sender_id,
      senderName: m.sender_name,
      msgType: m.type,
      content: typeof m.content === 'string' ? JSON.parse(m.content) : m.content,
      createdAt: new Date(m.created_at).getTime(),
    }));
  }
}
