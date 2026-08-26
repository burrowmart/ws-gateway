import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createChatServiceClient, type ChatServiceClient } from '@demo/contracts';

/**
 * Thin wrapper over the shared typed chat-service client. A fresh client is
 * built per call (cheap — it's a closure over `fetch`, not a connection) so
 * the caller's own bearer token and correlation id — both per-WS-connection,
 * not process-wide — ride along as headers.
 */
@Injectable()
export class ChatUpstreamService {
  constructor(private readonly config: ConfigService) {}

  private client(authHeader: string | null, cid: string): ChatServiceClient {
    return createChatServiceClient({
      baseUrl: this.config.get<string>('chatServiceUrl')!,
      defaultHeaders: {
        'x-correlation-id': cid,
        ...(authHeader ? { Authorization: `Bearer ${authHeader}` } : {}),
      },
    });
  }

  checkMembership(conversationId: string, email: string, authHeader: string | null, cid: string): Promise<boolean> {
    return this.client(authHeader, cid).checkMembership(conversationId, email);
  }

  /** Ascending by seq (chat-service sorts { seq: 1 }) — ready to replay in order as-is. */
  async listAfterSeq(
    conversationId: string,
    afterSeq: number,
    authHeader: string | null,
    cid: string,
  ): Promise<Array<{ id: string; conversationId: string; senderEmail: string; body: string; seq: number; createdAt: string }>> {
    // limit: 500 — a demo-scale single fetch rather than paging; the tail
    // after a reconnect is expected to be small (see README for the tradeoff).
    const page = await this.client(authHeader, cid).listMessages(conversationId, { afterSeq, limit: 500 });
    return page.data as Array<{
      id: string;
      conversationId: string;
      senderEmail: string;
      body: string;
      seq: number;
      createdAt: string;
    }>;
  }
}
