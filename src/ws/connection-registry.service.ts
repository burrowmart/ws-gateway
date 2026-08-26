import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AuthedSocket } from './types';

/**
 * In-process email -> Set<socket> registry (multi-device: one email can hold
 * several sockets). This is per-pod only — it decides which *local* sockets
 * to write to; cross-pod delivery is Redis pub/sub's job (RedisFanoutService).
 */
@Injectable()
export class ConnectionRegistryService implements OnModuleDestroy {
  private readonly logger = new Logger(ConnectionRegistryService.name);
  private readonly byEmail = new Map<string, Set<AuthedSocket>>();
  private heartbeatTimer?: NodeJS.Timeout;

  constructor(private readonly config: ConfigService) {}

  /** Called once by WsServerService after the HTTP server is attached. */
  startHeartbeat(): void {
    const intervalMs = this.config.get<number>('ws.heartbeatIntervalMs')!;
    this.heartbeatTimer = setInterval(() => this.pingAll(), intervalMs);
    this.heartbeatTimer.unref();
  }

  onModuleDestroy(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
  }

  register(socket: AuthedSocket): void {
    const set = this.byEmail.get(socket.meta.email) ?? new Set();
    set.add(socket);
    this.byEmail.set(socket.meta.email, set);
  }

  unregister(socket: AuthedSocket): void {
    const set = this.byEmail.get(socket.meta.email);
    if (!set) return;
    set.delete(socket);
    if (set.size === 0) this.byEmail.delete(socket.meta.email);
  }

  socketsFor(email: string): ReadonlySet<AuthedSocket> {
    return this.byEmail.get(email) ?? new Set();
  }

  private pingAll(): void {
    const idleTimeoutMs = this.config.get<number>('ws.idleTimeoutMs')!;
    const now = Date.now();

    for (const sockets of this.byEmail.values()) {
      for (const socket of sockets) {
        if (now - socket.meta.lastPongAt > idleTimeoutMs) {
          // Terminate rather than close(): skips the closing handshake, which
          // a truly-gone peer (the common case here) will never complete.
          this.logger.warn({ email: socket.meta.email, cid: socket.meta.cid }, 'WS idle timeout — terminating');
          socket.terminate();
          continue;
        }
        socket.ping();
      }
    }
  }
}
