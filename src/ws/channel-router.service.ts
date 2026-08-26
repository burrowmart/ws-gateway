import { Injectable, Logger } from '@nestjs/common';
import { RedisFanoutService } from './redis-fanout.service';
import { ChatUpstreamService } from './upstream/chat-upstream.service';
import { NotificationUpstreamService } from './upstream/notification-upstream.service';
import { sendFrame } from './send-frame';
import type { AuthedSocket, Channel, ClientFrame, ServerFrame } from './types';

type ParsedChannel = { kind: 'notifications' } | { kind: 'chat'; conversationId: string };

function parseChannel(channel: string): ParsedChannel | null {
  if (channel === 'notifications') return { kind: 'notifications' };
  if (channel.startsWith('chat:') && channel.length > 'chat:'.length) {
    return { kind: 'chat', conversationId: channel.slice('chat:'.length) };
  }
  return null;
}

/** Best-effort parse of a raw WS text frame into a ClientFrame — null on anything malformed. */
export function parseClientFrame(raw: string): ClientFrame | null {
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof obj !== 'object' || obj === null) return null;
  const { channel, action, payload } = obj as Record<string, unknown>;
  if (typeof channel !== 'string' || !parseChannel(channel)) return null;
  if (action !== 'join' && action !== 'leave') return null;
  if (payload !== undefined && (typeof payload !== 'object' || payload === null)) return null;
  return { channel: channel as Channel, action, payload: payload as ClientFrame['payload'] };
}

/**
 * Orchestrates join/leave frames: membership gate for chat:*, ref-counted
 * Redis subscribe, and — when the frame carries lastSeen — the resume replay,
 * with the fan-out service buffering any live traffic that arrives mid-fetch
 * (see RedisFanoutService / ConnectionMeta.replayBuffers).
 */
@Injectable()
export class ChannelRouterService {
  private readonly logger = new Logger(ChannelRouterService.name);

  constructor(
    private readonly fanout: RedisFanoutService,
    private readonly chat: ChatUpstreamService,
    private readonly notifications: NotificationUpstreamService,
  ) {}

  async handle(socket: AuthedSocket, frame: ClientFrame): Promise<void> {
    if (frame.action === 'join') return this.join(socket, frame);
    return this.leave(socket, frame);
  }

  private async join(socket: AuthedSocket, frame: ClientFrame): Promise<void> {
    const { channel } = frame;
    const parsed = parseChannel(channel)!; // validated in parseClientFrame

    if (parsed.kind === 'chat') {
      const allowed = await this.chat
        .checkMembership(parsed.conversationId, socket.meta.email, socket.meta.authHeader, socket.meta.cid)
        .catch((err) => {
          this.logger.warn({ err, cid: socket.meta.cid, channel }, 'membership check failed');
          return false;
        });
      if (!allowed) {
        sendFrame(socket, { channel, action: 'error', payload: { reason: 'not_a_member' } });
        return;
      }
    }

    socket.meta.subscriptions.add(channel);
    // Open the buffer before subscribing so a message racing the SUBSCRIBE
    // call is queued, never dropped and never delivered ahead of replay.
    socket.meta.replayBuffers.set(channel, []);
    await this.fanout.subscribe(channel, socket);

    const lastSeen = frame.payload?.lastSeen;
    try {
      if (lastSeen !== undefined) {
        await this.replay(socket, channel, parsed, lastSeen);
      }
    } catch (err) {
      this.logger.warn({ err, cid: socket.meta.cid, channel }, 'resume replay failed');
      sendFrame(socket, { channel, action: 'error', payload: { reason: 'upstream_unavailable' } });
    } finally {
      this.flushBuffer(socket, channel);
    }

    sendFrame(socket, { channel, action: 'ack', payload: {} });
  }

  private async replay(
    socket: AuthedSocket,
    channel: Channel,
    parsed: ParsedChannel,
    lastSeen: number | string,
  ): Promise<void> {
    const { authHeader, cid } = socket.meta;

    if (parsed.kind === 'notifications') {
      const items = await this.notifications.listRecentAfter(
        typeof lastSeen === 'string' ? lastSeen : undefined,
        authHeader,
        cid,
      );
      for (const item of items) {
        sendFrame(socket, { channel, action: 'replay', payload: item as unknown as ServerFrame['payload'] });
      }
      return;
    }

    const afterSeq = typeof lastSeen === 'number' ? lastSeen : Number(lastSeen) || 0;
    const items = await this.chat.listAfterSeq(parsed.conversationId, afterSeq, authHeader, cid);
    for (const item of items) {
      sendFrame(socket, { channel, action: 'replay', payload: item as unknown as ServerFrame['payload'] });
    }
  }

  /** Stops buffering (further live traffic is delivered immediately) and flushes what queued up during the fetch. */
  private flushBuffer(socket: AuthedSocket, channel: Channel): void {
    const buffered = socket.meta.replayBuffers.get(channel) ?? [];
    socket.meta.replayBuffers.delete(channel);
    for (const frame of buffered) sendFrame(socket, frame);
  }

  private async leave(socket: AuthedSocket, frame: ClientFrame): Promise<void> {
    const { channel } = frame;
    socket.meta.subscriptions.delete(channel);
    socket.meta.replayBuffers.delete(channel);
    await this.fanout.unsubscribe(channel, socket);
    sendFrame(socket, { channel, action: 'ack', payload: {} });
  }
}
