import { Module, OnModuleDestroy, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { WS_REDIS_CLIENT, WS_REDIS_SUBSCRIBER } from './redis.tokens';

@Module({
  providers: [
    {
      provide: WS_REDIS_CLIENT,
      useFactory: (config: ConfigService): Redis => new Redis(config.get<string>('redisUrl')!),
      inject: [ConfigService],
    },
    {
      // ioredis puts a connection into subscriber mode on the first SUBSCRIBE
      // call, after which it can only issue (P)SUBSCRIBE/(P)UNSUBSCRIBE/PING —
      // it must never be the same connection used for SETNX/GET/DEL above.
      provide: WS_REDIS_SUBSCRIBER,
      useFactory: (config: ConfigService): Redis => new Redis(config.get<string>('redisUrl')!),
      inject: [ConfigService],
    },
  ],
  exports: [WS_REDIS_CLIENT, WS_REDIS_SUBSCRIBER],
})
export class WsRedisModule implements OnModuleDestroy {
  constructor(
    @Inject(WS_REDIS_CLIENT) private readonly client: Redis,
    @Inject(WS_REDIS_SUBSCRIBER) private readonly subscriber: Redis,
  ) {}

  async onModuleDestroy(): Promise<void> {
    await Promise.all([this.client.quit(), this.subscriber.quit()]);
  }
}
