import { Body, Controller, ForbiddenException, Get, Post } from '@nestjs/common';
import { config } from '../config';
import { AuthService } from './auth.service';

@Controller('api/auth')
export class AuthController {
  constructor(private auth: AuthService) {}

  /** The login screen asks this to know whether to show the access-code field. */
  @Get('gate')
  gate() {
    return { gated: !!config.gateCode };
  }

  /** Invite-only demo gate (see config.gateCode). Checked on BOTH otp steps so
   *  the code can't be skipped by calling verify directly. */
  private assertGate(gateCode?: string) {
    if (config.gateCode && gateCode !== config.gateCode) {
      throw new ForbiddenException('Access code required (ask the person who shared this app)');
    }
  }

  @Post('otp/request')
  requestOtp(@Body() body: { phone: string; gateCode?: string }) {
    this.assertGate(body?.gateCode);
    return this.auth.requestOtp(body?.phone ?? '');
  }

  @Post('otp/verify')
  verifyOtp(@Body() body: { phone: string; code: string; platform?: string; displayName?: string; gateCode?: string }) {
    this.assertGate(body?.gateCode);
    return this.auth.verifyOtp(body?.phone ?? '', body?.code ?? '', body?.platform ?? 'web', body?.displayName);
  }

  @Post('refresh')
  refresh(@Body() body: { refresh: string }) {
    return this.auth.refresh(body?.refresh ?? '');
  }
}
