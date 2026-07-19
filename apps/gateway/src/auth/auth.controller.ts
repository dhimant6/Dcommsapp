import { Body, Controller, Post } from '@nestjs/common';
import { AuthService } from './auth.service';

@Controller('api/auth')
export class AuthController {
  constructor(private auth: AuthService) {}

  @Post('otp/request')
  requestOtp(@Body() body: { phone: string }) {
    return this.auth.requestOtp(body?.phone ?? '');
  }

  @Post('otp/verify')
  verifyOtp(@Body() body: { phone: string; code: string; platform?: string; displayName?: string }) {
    return this.auth.verifyOtp(body?.phone ?? '', body?.code ?? '', body?.platform ?? 'web', body?.displayName);
  }

  @Post('refresh')
  refresh(@Body() body: { refresh: string }) {
    return this.auth.refresh(body?.refresh ?? '');
  }
}
