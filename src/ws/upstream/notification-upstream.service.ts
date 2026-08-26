import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createNotificationServiceClient, type Notification } from '@demo/contracts';

@Injectable()
export class NotificationUpstreamService {
  constructor(private readonly config: ConfigService) {}

  /**
   * notification-service has no afterId/afterSeq filter — it's a flat
   * paginated list, newest-first. Resume fetches the recent page, reverses
   * it to ascending, and filters client-side by createdAt (ISO strings sort
   * lexicographically). Demo-scale: a single page, not a cursor loop.
   */
  async listRecentAfter(
    lastSeenIso: string | undefined,
    authHeader: string | null,
    cid: string,
  ): Promise<Notification[]> {
    const client = createNotificationServiceClient({
      baseUrl: this.config.get<string>('notificationServiceUrl')!,
      defaultHeaders: {
        'x-correlation-id': cid,
        ...(authHeader ? { Authorization: `Bearer ${authHeader}` } : {}),
      },
    });

    const page = await client.listNotifications({ limit: 200 });
    const ascending = [...page.data].reverse();
    if (!lastSeenIso) return ascending;
    return ascending.filter((n) => n.createdAt > lastSeenIso);
  }
}
