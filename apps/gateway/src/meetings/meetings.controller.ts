import { Body, Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import { config } from '../config';
import { MeetingsService } from './meetings.service';

@Controller('api')
@UseGuards(AuthGuard)
export class MeetingsController {
  constructor(private meetings: MeetingsService) {}

  @Post('meetings')
  create(@Req() req: any, @Body() body: { title?: string; conversationId?: string }) {
    return this.meetings.create(req.auth.userId, body?.title, body?.conversationId);
  }

  @Get('meetings/:code')
  byCode(@Param('code') code: string) {
    return this.meetings.byCode(code);
  }

  /**
   * ICE servers for RTCPeerConnection. Empty list = host candidates only,
   * which connects fine on one machine or one LAN — exactly our dev setup.
   * With coturn running (docker path), STUN/TURN URLs appear here and calls
   * survive real NATs. The CLIENT code is identical either way; ICE tries
   * candidates in order of cost automatically.
   */
  @Get('calls/ice-config')
  iceConfig() {
    const servers: any[] = [];
    if (config.ice.stunUrl) servers.push({ urls: config.ice.stunUrl });
    if (config.ice.turnUrl)
      servers.push({ urls: config.ice.turnUrl, username: config.ice.turnUser, credential: config.ice.turnPass });
    return { iceServers: servers };
  }
}
