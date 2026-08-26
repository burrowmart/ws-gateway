import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpAdapterHost } from '@nestjs/core';
import type { Server as HttpServer, IncomingMessage } from 'http';
import type { Duplex } from 'stream';
import { WebSocketServer, type RawData } from 'ws';
import { WS_PATH } from '../constants';
import { TicketService, type TicketClaims } from '../ticket/ticket.service';
import { ConnectionRegistryService } from './connection-registry.service';
import { RedisFanoutService } from './redis-fanout.service';
import { ChannelRouterService, parseClientFrame } from './channel-router.service';
import { sendFrame } from './send-frame';
import type { AuthedSocket } from './types';

/**
 * Attaches a `ws` server to the same HTTP server Nest already listens on, in
 * noServer mode — Nest/Express never sees `/ws` upgrade traffic, and this is
 * the only place in the whole system that opens a server-side WebSocket.
 *
 * `attach()` is called explicitly from main.ts (and from tests) right after
 * `app.listen()` resolves — NOT from an `OnModuleInit` hook. Nest's HTTP
 * adapter only creates the underlying `http.Server` instance inside
 * `listen()`, which runs after every lifecycle hook has already fired, so
 * `getHttpServer()` would return undefined at OnModuleInit time (this also
 * breaks scripts/generate-openapi.ts, which builds the app but never listens).
 */
@Injectable()
export class WsServerService {
  private readonly logger = new Logger(WsServerService.name);
  private wss!: WebSocketServer;

  constructor(
    private readonly httpAdapterHost: HttpAdapterHost,
    private readonly config: ConfigService,
    private readonly tickets: TicketService,
    private readonly registry: ConnectionRegistryService,
    private readonly fanout: RedisFanoutService,
    private readonly router: ChannelRouterService,
  ) {}

  attach(): void {
    const httpServer = this.httpAdapterHost.httpAdapter.getHttpServer() as HttpServer;
    this.wss = new WebSocketServer({ noServer: true });

    httpServer.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      const url = new URL(req.url ?? '', 'http://internal');
      if (url.pathname !== WS_PATH) {
        socket.destroy();
        return;
      }
      // All async ticket verification happens HERE, before the WS protocol
      // handshake completes — never inside the handleUpgrade callback. Once
      // that callback fires the client already considers itself connected
      // and can send data immediately; if the callback itself awaited
      // anything before attaching the 'message' listener, a fast client's
      // first frame could arrive (and be silently lost — EventEmitters don't
      // buffer for listeners that aren't attached yet) before the gateway
      // was ready to receive it. handleUpgrade's callback below is
      // synchronous end-to-end specifically to close that window.
      this.authenticate(req, url)
        .then((outcome) => {
          this.wss.handleUpgrade(req, socket, head, (ws) => {
            if (outcome.ok) this.onConnection(ws as AuthedSocket, outcome.claims, outcome.authHeader);
            else this.rejectUnauthorized(ws as AuthedSocket, outcome.reason);
          });
        })
        .catch((err) => {
          this.logger.error({ err }, 'ticket authentication failed unexpectedly');
          socket.destroy();
        });
    });

    this.registry.startHeartbeat();
    this.logger.log(`WS server attached on ${WS_PATH}`);
  }

  private async authenticate(
    req: IncomingMessage,
    url: URL,
  ): Promise<
    | { ok: true; claims: TicketClaims; authHeader: string | null }
    | { ok: false; reason: string }
  > {
    const ticket = url.searchParams.get('ticket');
    if (!ticket) return { ok: false, reason: 'missing ticket' };

    let claims: TicketClaims;
    try {
      claims = this.tickets.verify(ticket);
    } catch {
      return { ok: false, reason: 'invalid or expired ticket' };
    }

    const ttl = this.config.get<number>('wsTicketTtlSeconds')!;
    const { firstUse, authHeader } = await this.tickets.consume(claims.jti, ttl);
    if (!firstUse) return { ok: false, reason: 'ticket already used' };

    return { ok: true, claims, authHeader };
  }

  /** Synchronous end-to-end — see the comment in attach() for why that matters. */
  private onConnection(ws: AuthedSocket, claims: TicketClaims, authHeader: string | null): void {
    ws.meta = {
      email: claims.email,
      cid: claims.cid,
      authHeader,
      lastPongAt: Date.now(),
      subscriptions: new Set(),
      replayBuffers: new Map(),
    };

    this.registry.register(ws);
    this.logger.log({ email: ws.meta.email, cid: ws.meta.cid }, 'WS connected');

    ws.on('pong', () => {
      ws.meta.lastPongAt = Date.now();
    });
    ws.on('message', (data: RawData) => this.onMessage(ws, data));
    ws.on('close', () => this.onClose(ws));
    ws.on('error', (err: Error) => this.logger.warn({ err, cid: ws.meta.cid }, 'WS connection error'));
  }

  /**
   * The handshake still completes (this fires after `wss.handleUpgrade`) so
   * the client gets a real WS `close` event carrying 4401 — a raw HTTP 401
   * would arrive as a connection failure the ticket/reason can't ride along on.
   */
  private rejectUnauthorized(ws: AuthedSocket, reason: string): void {
    this.logger.warn({ reason }, 'WS handshake rejected');
    ws.close(4401, reason);
  }

  private onMessage(ws: AuthedSocket, data: RawData): void {
    const frame = parseClientFrame(data.toString());
    if (!frame) {
      sendFrame(ws, { channel: 'notifications', action: 'error', payload: { reason: 'invalid_frame' } });
      return;
    }
    this.router
      .handle(ws, frame)
      .catch((err) => this.logger.error({ err, cid: ws.meta.cid }, 'frame handling failed'));
  }

  private onClose(ws: AuthedSocket): void {
    this.registry.unregister(ws);
    this.fanout
      .dropAll(ws)
      .catch((err) => this.logger.warn({ err, cid: ws.meta.cid }, 'subscription cleanup on close failed'));
    this.logger.log({ email: ws.meta.email, cid: ws.meta.cid }, 'WS disconnected');
  }
}
