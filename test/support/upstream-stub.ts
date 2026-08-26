import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http';
import type { AddressInfo } from 'net';

export interface ChatMessageStub {
  id: string;
  conversationId: string;
  senderEmail: string;
  body: string;
  seq: number;
  createdAt: string;
}

export interface NotificationStub {
  id: string;
  userEmail: string;
  type: string;
  payload: Record<string, unknown>;
  read: boolean;
  createdAt: string;
}

/**
 * Minimal stand-in for chat-service + notification-service's REST surface —
 * just enough to match the real contract ws-gateway actually calls
 * (GET .../members/:email, GET .../messages?afterSeq=, GET /notifications),
 * so the e2e suite can run without those repos checked out. Point both
 * CHAT_SERVICE_URL and NOTIFICATION_SERVICE_URL at the same instance — the
 * paths don't collide.
 */
export class UpstreamStub {
  private server?: Server;
  private readonly members = new Map<string, Set<string>>();
  private readonly messages = new Map<string, ChatMessageStub[]>();
  private readonly notifications: NotificationStub[] = [];
  /** Artificial delay before responding to GET .../messages — lets a test fire a "live" Redis publish while a resume fetch is still in flight. */
  listAfterSeqDelayMs = 0;

  addMember(conversationId: string, email: string): void {
    const set = this.members.get(conversationId) ?? new Set();
    set.add(email);
    this.members.set(conversationId, set);
  }

  addMessage(msg: ChatMessageStub): void {
    const list = this.messages.get(msg.conversationId) ?? [];
    list.push(msg);
    this.messages.set(msg.conversationId, list);
  }

  /** Stored newest-first, matching notification-service's real sort order. */
  addNotification(n: NotificationStub): void {
    this.notifications.unshift(n);
  }

  async start(): Promise<string> {
    this.server = createServer((req, res) => {
      this.handle(req, res).catch((err) => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ message: String(err) }));
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(0, resolve));
    const { port } = this.server!.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve, reject) => this.server!.close((err) => (err ? reject(err) : resolve())));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '', 'http://internal');
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    const memberMatch = url.pathname.match(/^\/conversations\/([^/]+)\/members\/([^/]+)$/);
    if (memberMatch && req.method === 'GET') {
      const conversationId = decodeURIComponent(memberMatch[1]);
      const email = decodeURIComponent(memberMatch[2]);
      const isMember = this.members.get(conversationId)?.has(email) ?? false;
      if (!isMember) return json(404, { message: 'not a member' });
      return json(200, { conversationId, email, member: true });
    }

    const messagesMatch = url.pathname.match(/^\/conversations\/([^/]+)\/messages$/);
    if (messagesMatch && req.method === 'GET') {
      if (this.listAfterSeqDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, this.listAfterSeqDelayMs));
      }
      const conversationId = decodeURIComponent(messagesMatch[1]);
      const afterSeq = Number(url.searchParams.get('afterSeq') ?? '0');
      const limit = Number(url.searchParams.get('limit') ?? '20');
      const all = (this.messages.get(conversationId) ?? [])
        .filter((m) => m.seq > afterSeq)
        .sort((a, b) => a.seq - b.seq);
      return json(200, { data: all.slice(0, limit), total: all.length, page: 1, limit });
    }

    if (url.pathname === '/notifications' && req.method === 'GET') {
      const limit = Number(url.searchParams.get('limit') ?? '20');
      return json(200, { data: this.notifications.slice(0, limit), total: this.notifications.length, page: 1, limit });
    }

    json(404, { message: `no stub route for ${req.method} ${url.pathname}` });
  }
}
