import { Inject, Injectable, Logger } from '@nestjs/common';
import Redis from 'ioredis';
import { WS_REDIS_SUBSCRIBER } from '../redis/redis.tokens';
import type { AuthedSocket, Channel } from './types';
import { sendFrame } from './send-frame';

/**
 * Maps the client-facing channel name to the actual Redis pub/sub channel.
 * `chat:{id}` is already conversation-scoped and identical on both sides.
 * `notifications` is per-user on the Redis side (notification-service
 * publishes to `notifications:{email}`) — the client never sees the email
 * suffix, it's derived from the authenticated connection.
 */
const toRedisChannel = (channel: Channel, email: string): string =>
  channel === 'notifications' ? `notifications:${email}` : channel;

/** Inverse of toRedisChannel — used only to build the outgoing ServerFrame's `channel` field. */
const toClientChannel = (redisChannelName: string): Channel =>
  redisChannelName.startsWith('notifications:') ? 'notifications' : (redisChannelName as Channel);

/**
 * Ref-counted Redis subscribe, keyed by the *actual* Redis channel name (not
 * the client-facing one) — critical for `notifications`, where every user has
 * a distinct Redis channel. Keying by the client-facing name would collapse
 * every locally-connected user's "notifications" subscription into one
 * bucket and leak each other's pushes. A `chat:{id}` channel shared by three
 * local participants still results in exactly one Redis `SUBSCRIBE` — not
 * three — dropped only once the last of them leaves or disconnects.
 */
@Injectable()
export class RedisFanoutService {
  private readonly logger = new Logger(RedisFanoutService.name);
  private readonly localSubscribers = new Map<string, Set<AuthedSocket>>();

  constructor(@Inject(WS_REDIS_SUBSCRIBER) private readonly subscriber: Redis) {
    this.subscriber.on('message', (redisChannelName: string, message: string) =>
      this.deliver(redisChannelName, message),
    );
  }

  async subscribe(channel: Channel, socket: AuthedSocket): Promise<void> {
    const redisChannelName = toRedisChannel(channel, socket.meta.email);
    let sockets = this.localSubscribers.get(redisChannelName);
    if (!sockets) {
      sockets = new Set();
      this.localSubscribers.set(redisChannelName, sockets);
      await this.subscriber.subscribe(redisChannelName);
    }
    sockets.add(socket);
  }

  async unsubscribe(channel: Channel, socket: AuthedSocket): Promise<void> {
    const redisChannelName = toRedisChannel(channel, socket.meta.email);
    const sockets = this.localSubscribers.get(redisChannelName);
    if (!sockets) return;
    sockets.delete(socket);
    if (sockets.size === 0) {
      this.localSubscribers.delete(redisChannelName);
      await this.subscriber.unsubscribe(redisChannelName);
    }
  }

  /** Called on socket close — removes it from every channel it held. */
  async dropAll(socket: AuthedSocket): Promise<void> {
    await Promise.all([...socket.meta.subscriptions].map((channel) => this.unsubscribe(channel, socket)));
  }

  private deliver(redisChannelName: string, message: string): void {
    const sockets = this.localSubscribers.get(redisChannelName);
    if (!sockets || sockets.size === 0) return;

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(message);
    } catch (err) {
      this.logger.warn({ err, redisChannelName }, 'Dropping non-JSON pub/sub message');
      return;
    }

    const channel = toClientChannel(redisChannelName);
    const frame = { channel, action: 'event' as const, payload };

    for (const socket of sockets) {
      // A resume is in flight for this socket+channel: queue instead of
      // sending, so this live message can't overtake history that hasn't
      // been replayed yet. ChannelRouterService flushes the queue, in
      // arrival order, right after the replay frames.
      const buffer = socket.meta.replayBuffers.get(channel);
      if (buffer) {
        buffer.push(frame);
        continue;
      }
      sendFrame(socket, frame);
    }
  }
}
