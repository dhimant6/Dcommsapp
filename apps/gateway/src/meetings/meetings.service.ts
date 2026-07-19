import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import * as crypto from 'crypto';
import { MeetingInfo } from '@dcom/shared';
import { DB, DbPort } from '../ports/ports';

/**
 * MTR meetings: a joinable room identified by a short human-typeable code —
 * the thing a room console keypad or a "join with code" screen enters.
 *
 * Durable in Postgres (codes must survive gateway restarts — a meeting invite
 * sent an hour ago has to still work). LIVE membership is KV-only (ws.service)
 * because who-is-in-the-room-right-now is worthless after the fact.
 */
@Injectable()
export class MeetingsService {
  constructor(@Inject(DB) private db: DbPort) {}

  /** Code alphabet drops 0/O/1/I — these get read aloud in meeting rooms. */
  private newCode(): string {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let s = '';
    for (const b of crypto.randomBytes(8)) s += alphabet[b % 32];
    return `${s.slice(0, 4)}-${s.slice(4)}`;
  }

  async create(meId: string, title?: string, conversationId?: string): Promise<MeetingInfo> {
    const id = crypto.randomUUID();
    const code = this.newCode();
    await this.db.query(
      `INSERT INTO meetings (id, room_code, title, conversation_id, created_by, expires_at)
       VALUES ($1, $2, $3, $4, $5, now() + interval '24 hours')`,
      [id, code, title?.trim() || 'Meeting', conversationId ?? null, meId],
    );
    return { roomId: id, roomCode: code, title: title?.trim() || 'Meeting', conversationId };
  }

  async byCode(code: string): Promise<MeetingInfo> {
    const norm = code.trim().toUpperCase().replace(/[^A-Z2-9]/g, '');
    const formatted = `${norm.slice(0, 4)}-${norm.slice(4, 8)}`;
    const { rows } = await this.db.query(
      `SELECT id, room_code, title, conversation_id FROM meetings WHERE room_code = $1 AND expires_at > now()`,
      [formatted],
    );
    if (!rows[0]) throw new NotFoundException('No meeting with that code (or it expired)');
    return {
      roomId: rows[0].id,
      roomCode: rows[0].room_code,
      title: rows[0].title,
      conversationId: rows[0].conversation_id ?? undefined,
    };
  }
}
