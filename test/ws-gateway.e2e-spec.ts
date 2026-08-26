/**
 * ws-gateway e2e verification — two fake WS clients (the `ws` package,
 * driven directly) against a real gateway instance, real Redis pub/sub, and
 * UpstreamStub standing in for chat-service/notification-service's REST
 * surface. Proves the four required scenarios:
 *   (a) two sockets, same user, notifications → a publish reaches both
 *   (b) chat:c1 subscriber does not receive chat:c2 traffic
 *   (c) reconnect with lastSeen replays missed chat messages, in order,
 *       before live ones (including a live message that arrives while the
 *       resume fetch is still in flight — proves the buffering, not just
 *       the happy path)
 *   (d) invalid / reused ticket closes 4401
 */
import { randomUUID } from 'crypto';
import type { AddressInfo } from 'net';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import Redis from 'ioredis';
import WebSocket, { type RawData } from 'ws';
import { AppModule } from '../src/app.module';
import { WsServerService } from '../src/ws/ws-server.service';
import type { UpstreamStub } from './support/upstream-stub';

interface Frame {
  channel: string;
  action: string;
  payload: Record<string, unknown>;
}

describe('ws-gateway (e2e)', () => {
  let app: INestApplication;
  let baseUrl: string;
  let wsUrl: string;
  let stub: UpstreamStub;
  let publisher: Redis;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.listen(0);
    // Must run after listen() — see WsServerService for why.
    app.get(WsServerService).attach();

    const address = app.getHttpServer().address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
    wsUrl = `ws://127.0.0.1:${address.port}/ws`;

    stub = (global as unknown as { __UPSTREAM_STUB__: UpstreamStub }).__UPSTREAM_STUB__;
    publisher = new Redis(process.env.REDIS_URL!);
  });

  afterAll(async () => {
    await publisher.quit();
    await app.close();
  });

  async function mintTicket(email: string): Promise<string> {
    const res = await fetch(`${baseUrl}/ws/ticket`, {
      method: 'POST',
      headers: { 'x-test-user-email': email },
    });
    const body = (await res.json()) as { ticket: string };
    return body.ticket;
  }

  function connect(ticket: string): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`${wsUrl}?ticket=${encodeURIComponent(ticket)}`);
      ws.once('open', () => resolve(ws));
      ws.once('error', reject);
    });
  }

  function join(ws: WebSocket, channel: string, payload?: Record<string, unknown>): void {
    ws.send(JSON.stringify({ channel, action: 'join', payload }));
  }

  /** Resolves with the next frame matching `predicate` — earlier non-matching frames are ignored, not consumed. */
  function nextFrame(ws: WebSocket, predicate: (f: Frame) => boolean, timeoutMs = 5000): Promise<Frame> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for frame')), timeoutMs);
      const onMessage = (data: RawData) => {
        const frame = JSON.parse(data.toString()) as Frame;
        if (predicate(frame)) {
          clearTimeout(timer);
          ws.off('message', onMessage);
          resolve(frame);
        }
      };
      ws.on('message', onMessage);
    });
  }

  function collectFrames(ws: WebSocket, count: number, timeoutMs = 10000): Promise<Frame[]> {
    return new Promise((resolve, reject) => {
      const frames: Frame[] = [];
      const timer = setTimeout(
        () => reject(new Error(`timed out; got ${frames.length}/${count}: ${JSON.stringify(frames)}`)),
        timeoutMs,
      );
      const onMessage = (data: RawData) => {
        frames.push(JSON.parse(data.toString()) as Frame);
        if (frames.length === count) {
          clearTimeout(timer);
          ws.off('message', onMessage);
          resolve(frames);
        }
      };
      ws.on('message', onMessage);
    });
  }

  function closeCode(ws: WebSocket): Promise<number> {
    return new Promise((resolve) => {
      ws.once('close', (code) => resolve(code));
      ws.once('error', () => undefined); // a non-1000 close is not a client-level error
    });
  }

  it('(a) two sockets on the same user, notifications channel → one publish reaches both', async () => {
    const email = `alice-${randomUUID()}@example.com`;
    const [ws1, ws2] = await Promise.all([connect(await mintTicket(email)), connect(await mintTicket(email))]);

    const ack1 = nextFrame(ws1, (f) => f.action === 'ack');
    join(ws1, 'notifications');
    await ack1;

    const ack2 = nextFrame(ws2, (f) => f.action === 'ack');
    join(ws2, 'notifications');
    await ack2;

    const event1 = nextFrame(ws1, (f) => f.action === 'event');
    const event2 = nextFrame(ws2, (f) => f.action === 'event');

    // What notification-service really does after persist-then-push.
    await publisher.publish(
      `notifications:${email}`,
      JSON.stringify({ id: 'n1', userEmail: email, type: 'ORDER_CONFIRMED', payload: {}, read: false, createdAt: new Date().toISOString() }),
    );

    const [f1, f2] = await Promise.all([event1, event2]);
    expect(f1.channel).toBe('notifications');
    expect(f1.payload.id).toBe('n1');
    expect(f2.payload.id).toBe('n1');

    ws1.close();
    ws2.close();
  });

  it('(b) a chat:c1 subscriber does not receive chat:c2 traffic', async () => {
    const emailA = `a-${randomUUID()}@example.com`;
    const emailB = `b-${randomUUID()}@example.com`;
    const c1 = `c1-${randomUUID()}`;
    const c2 = `c2-${randomUUID()}`;
    stub.addMember(c1, emailA);
    stub.addMember(c2, emailB);

    const wsA = await connect(await mintTicket(emailA));
    const wsB = await connect(await mintTicket(emailB));

    const ackA = nextFrame(wsA, (f) => f.action === 'ack');
    join(wsA, `chat:${c1}`);
    await ackA;

    const ackB = nextFrame(wsB, (f) => f.action === 'ack');
    join(wsB, `chat:${c2}`);
    await ackB;

    let bSawAnEvent = false;
    wsB.on('message', (data) => {
      const f = JSON.parse(data.toString()) as Frame;
      if (f.action === 'event') bSawAnEvent = true;
    });

    const eventA = nextFrame(wsA, (f) => f.action === 'event');
    await publisher.publish(
      `chat:${c1}`,
      JSON.stringify({ id: 'm1', conversationId: c1, senderEmail: emailA, body: 'hi', seq: 1, createdAt: new Date().toISOString() }),
    );

    const frameA = await eventA;
    expect(frameA.payload.id).toBe('m1');

    // Give B's socket a real chance to (not) receive cross-conversation traffic.
    await new Promise((r) => setTimeout(r, 300));
    expect(bSawAnEvent).toBe(false);

    wsA.close();
    wsB.close();
  });

  it(
    '(c) reconnect with lastSeen replays missed chat messages, in order, before live ones',
    async () => {
      const email = `c-${randomUUID()}@example.com`;
      const conversationId = `conv-${randomUUID()}`;
      stub.addMember(conversationId, email);
      stub.addMessage({ id: 'm1', conversationId, senderEmail: email, body: 'one', seq: 1, createdAt: new Date().toISOString() });
      stub.addMessage({ id: 'm2', conversationId, senderEmail: email, body: 'two', seq: 2, createdAt: new Date().toISOString() });
      stub.addMessage({ id: 'm3', conversationId, senderEmail: email, body: 'three', seq: 3, createdAt: new Date().toISOString() });

      // Slow the resume fetch so the "live" publish below lands while it's
      // still in flight — this is what actually exercises the buffer, not
      // just the ordering of two already-resolved calls.
      stub.listAfterSeqDelayMs = 600;

      const ws = await connect(await mintTicket(email));
      const framesPromise = collectFrames(ws, 4); // replay(2), replay(3), event(4), ack

      join(ws, `chat:${conversationId}`, { lastSeen: 1 });

      await new Promise((r) => setTimeout(r, 150)); // well inside the 600ms resume delay
      await publisher.publish(
        `chat:${conversationId}`,
        JSON.stringify({ id: 'm4', conversationId, senderEmail: email, body: 'four', seq: 4, createdAt: new Date().toISOString() }),
      );

      const frames = await framesPromise;
      stub.listAfterSeqDelayMs = 0;

      expect(frames.map((f) => f.action)).toEqual(['replay', 'replay', 'event', 'ack']);
      expect(frames[0].payload.seq).toBe(2);
      expect(frames[1].payload.seq).toBe(3);
      expect(frames[2].payload.seq).toBe(4);

      ws.close();
    },
    15000,
  );

  it('(d) an invalid ticket, and a reused one, both close with 4401', async () => {
    const garbage = new WebSocket(`${wsUrl}?ticket=not-a-real-ticket`);
    await expect(closeCode(garbage)).resolves.toBe(4401);

    const email = `d-${randomUUID()}@example.com`;
    const ticket = await mintTicket(email);

    const first = await connect(ticket);
    first.close();

    const second = new WebSocket(`${wsUrl}?ticket=${encodeURIComponent(ticket)}`);
    await expect(closeCode(second)).resolves.toBe(4401);
  });
});
