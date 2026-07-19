import { Body, Controller, Delete, Get, Post, Req, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import { PushService } from './push.service';

@Controller('api/push')
@UseGuards(AuthGuard)
export class PushController {
  constructor(private push: PushService) {}

  /** The browser needs the VAPID public key to create its subscription. */
  @Get('vapid-public-key')
  vapidKey() {
    return { publicKey: this.push.publicKey };
  }

  @Post('subscribe')
  async subscribe(@Req() req: any, @Body() body: { subscription: unknown }) {
    await this.push.saveSubscription(req.auth.userId, req.auth.deviceId, body?.subscription ?? null);
    return { ok: true };
  }

  @Delete('subscribe')
  async unsubscribe(@Req() req: any) {
    await this.push.removeSubscription(req.auth.userId, req.auth.deviceId);
    return { ok: true };
  }
}
