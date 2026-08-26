import { Module } from '@nestjs/common';
import { WsRedisModule } from '../redis/redis.module';
import { TicketModule } from '../ticket/ticket.module';
import { ConnectionRegistryService } from './connection-registry.service';
import { RedisFanoutService } from './redis-fanout.service';
import { ChannelRouterService } from './channel-router.service';
import { WsServerService } from './ws-server.service';
import { ChatUpstreamService } from './upstream/chat-upstream.service';
import { NotificationUpstreamService } from './upstream/notification-upstream.service';

@Module({
  imports: [WsRedisModule, TicketModule],
  providers: [
    ConnectionRegistryService,
    RedisFanoutService,
    ChannelRouterService,
    ChatUpstreamService,
    NotificationUpstreamService,
    WsServerService,
  ],
})
export class WsModule {}
