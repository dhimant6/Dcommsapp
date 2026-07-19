import { Module } from '@nestjs/common';
import { AdaptersModule } from './adapters/adapters.module';
import { AuthModule } from './auth/auth.module';
import { ChatModule } from './chat/chat.module';
import { MediaController } from './media/media.controller';
import { MeetingsController } from './meetings/meetings.controller';
import { MeetingsService } from './meetings/meetings.service';
import { PresenceController } from './ws/presence.controller';
import { PushService } from './push/push.service';
import { UsersController } from './users/users.controller';
import { WsService } from './ws/ws.service';

/**
 * Modular monolith: one deployable, clean seams. The ws/ + push pieces only
 * touch KV and the chat services — extracting a dedicated WS tier later is a
 * repo split, not a rewrite. Start monolith, split on evidence.
 */
@Module({
  imports: [AdaptersModule, AuthModule, ChatModule],
  controllers: [MediaController, MeetingsController, PresenceController, UsersController],
  providers: [MeetingsService, PushService, WsService],
})
export class AppModule {}
