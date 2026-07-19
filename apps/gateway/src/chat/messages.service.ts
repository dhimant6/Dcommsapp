import { Inject, Injectable } from '@nestjs/common';
import * as crypto from 'crypto';
import { ChatMessageRecv, ChatMessageSend } from '@dcom/shared';
import { DB, DbPort } from '../ports/ports';

/**
 * Message persistence. The single most important line is the ON CONFLICT:
 * it converts at-least-once delivery (clients retry sends after network
 * blips) into exactly-once storage. The client's UUID is the dedupe key;
 * the server's UUID is the authoritative identity.
 */
@Injectable()
export class MessagesService {
  constructor(@Inject(DB) private db: DbPort) {}

  async persist(senderId: string, senderName: string, msg: ChatMessageSend): Promise<ChatMessageRecv> {
    const id = crypto.randomUUID();
    const inserted = await this.db.query(
      `INSERT INTO messages (id, conversation_id, sender_id, client_msg_id, type, content)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (sender_id, client_msg_id) DO NOTHING
       RETURNING id, created_at`,
      [id, msg.conversationId, senderId, msg.clientMsgId, msg.msgType, JSON.stringify(msg.content)],
    );

    // Conflict path = retry of a message we already stored: return the
    // original row so the client's duplicate send gets the SAME ack.
    const row =
      inserted.rows[0] ??
      (
        await this.db.query(`SELECT id, created_at FROM messages WHERE sender_id = $1 AND client_msg_id = $2`, [
          senderId,
          msg.clientMsgId,
        ])
      ).rows[0];

    return {
      ...msg,
      serverMsgId: row.id,
      senderId,
      senderName,
      createdAt: new Date(row.created_at).getTime(),
    };
  }

  async markDelivered(messageIds: string[]): Promise<void> {
    if (!messageIds.length) return;
    // First delivery wins; delivered_at is "reached at least one device".
    await this.db.query(
      `UPDATE messages SET delivered_at = now() WHERE id = ANY($1::text[]) AND delivered_at IS NULL`,
      [messageIds],
    );
  }

  /** Read receipts as a WATERMARK on the membership row (see schema comment
   *  for the why). We advance to the newest of the acked ids; a stale ack
   *  (older than the current watermark) is a harmless no-op. */
  async advanceReadWatermark(conversationId: string, userId: string, messageIds: string[]): Promise<void> {
    if (!messageIds.length) return;
    await this.db.query(
      `UPDATE conversation_members cm SET last_read_message_id = target.id, last_read_at = now()
       FROM (
         SELECT id, created_at FROM messages WHERE id = ANY($3::text[]) AND conversation_id = $1
         ORDER BY created_at DESC LIMIT 1
       ) AS target
       WHERE cm.conversation_id = $1 AND cm.user_id = $2
         AND (cm.last_read_message_id IS NULL OR
              (SELECT created_at FROM messages WHERE id = cm.last_read_message_id) <= target.created_at)`,
      [conversationId, userId, messageIds],
    );
  }

  /** Sender ids of the given messages — receipts must route to the AUTHOR,
   *  not broadcast to the room. */
  async senderOf(messageIds: string[]): Promise<Map<string, string[]>> {
    if (!messageIds.length) return new Map();
    const { rows } = await this.db.query(`SELECT id, sender_id FROM messages WHERE id = ANY($1::text[])`, [
      messageIds,
    ]);
    const bySender = new Map<string, string[]>();
    for (const r of rows) {
      if (!bySender.has(r.sender_id)) bySender.set(r.sender_id, []);
      bySender.get(r.sender_id)!.push(r.id);
    }
    return bySender;
  }
}
