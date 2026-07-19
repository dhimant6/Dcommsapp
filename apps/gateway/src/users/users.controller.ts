import { Body, Controller, Get, Inject, Patch, Req, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import { DB, DbPort } from '../ports/ports';

@Controller('api')
@UseGuards(AuthGuard)
export class UsersController {
  constructor(@Inject(DB) private db: DbPort) {}

  @Get('me')
  async me(@Req() req: any) {
    const { rows } = await this.db.query(
      `SELECT id, phone_e164, display_name, avatar_url, is_room_device FROM users WHERE id = $1`,
      [req.auth.userId],
    );
    const u = rows[0];
    return { id: u.id, phone: u.phone_e164, displayName: u.display_name, avatarUrl: u.avatar_url, isRoomDevice: u.is_room_device };
  }

  @Patch('me')
  async update(@Req() req: any, @Body() body: { displayName?: string; isRoomDevice?: boolean }) {
    if (body?.displayName?.trim()) {
      await this.db.query(`UPDATE users SET display_name = $1 WHERE id = $2`, [
        body.displayName.trim().slice(0, 64),
        req.auth.userId,
      ]);
    }
    // MTR provisioning: flipping this marks the account as a room-device
    // ("resource account"), which the web client uses to boot into kiosk mode.
    if (typeof body?.isRoomDevice === 'boolean') {
      await this.db.query(`UPDATE users SET is_room_device = $1 WHERE id = $2`, [body.isRoomDevice, req.auth.userId]);
    }
    return this.me(req);
  }
}
