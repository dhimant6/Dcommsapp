import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import { ConversationsService } from './conversations.service';

@Controller('api')
@UseGuards(AuthGuard)
export class ChatController {
  constructor(private convs: ConversationsService) {}

  @Get('conversations')
  list(@Req() req: any) {
    return this.convs.listForUser(req.auth.userId);
  }

  @Post('conversations/direct')
  createDirect(@Req() req: any, @Body() body: { peerPhone: string }) {
    return this.convs.createDirect(req.auth.userId, body?.peerPhone ?? '');
  }

  @Post('conversations/group')
  createGroup(@Req() req: any, @Body() body: { title: string; memberPhones: string[] }) {
    return this.convs.createGroup(req.auth.userId, body?.title ?? '', body?.memberPhones ?? []);
  }

  @Get('messages/search')
  search(@Req() req: any, @Query('q') q?: string, @Query('limit') limit?: string) {
    return this.convs.search(req.auth.userId, q ?? '', limit ? parseInt(limit, 10) : 30);
  }

  /** Offline sync + pagination. since = "give me what I missed" (reconnect);
   *  before = "give me older" (scroll-up). Mutually exclusive by design. */
  @Get('conversations/:id/messages')
  history(
    @Req() req: any,
    @Param('id') id: string,
    @Query('since') since?: string,
    @Query('before') before?: string,
    @Query('limit') limit?: string,
  ) {
    return this.convs.history(
      id,
      req.auth.userId,
      since ? parseInt(since, 10) : undefined,
      before ? parseInt(before, 10) : undefined,
      limit ? parseInt(limit, 10) : 50,
    );
  }
}
