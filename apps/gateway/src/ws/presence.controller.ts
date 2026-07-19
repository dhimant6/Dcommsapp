import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import { WsService } from './ws.service';

@Controller('api')
@UseGuards(AuthGuard)
export class PresenceController {
  constructor(private ws: WsService) {}

  /** Snapshot for initial render; live updates arrive as WS presence events.
   *  Snapshot-then-stream is the standard pattern for any live view. */
  @Get('presence')
  presence(@Query('ids') ids: string) {
    return this.ws.presenceOf((ids ?? '').split(',').filter(Boolean).slice(0, 100));
  }
}
