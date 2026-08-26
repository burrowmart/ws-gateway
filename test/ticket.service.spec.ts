import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type Redis from 'ioredis';
import { TicketService } from '../src/ticket/ticket.service';

/**
 * Minimal fake matching only the two Redis calls TicketService actually
 * makes (`set` with NX/EX, and `getdel`) — enough to exercise the real
 * single-use semantics without a live Redis. The e2e suite (real Redis, per
 * this repo's convention for anything relying on genuine atomicity) covers
 * the rest.
 */
class FakeRedis {
  private readonly store = new Map<string, string>();

  async set(key: string, value: string, ..._rest: unknown[]): Promise<'OK' | null> {
    // Only the exact call shape TicketService makes is supported: EX ttl NX.
    if (this.store.has(key)) return null;
    this.store.set(key, value);
    return 'OK';
  }

  async getdel(key: string): Promise<string | null> {
    const value = this.store.get(key) ?? null;
    this.store.delete(key);
    return value;
  }
}

function makeConfig(secret: string): ConfigService {
  const values: Record<string, unknown> = { wsTicketTtlSeconds: 30, wsTicketSecret: secret };
  return { get: (key: string) => values[key] } as unknown as ConfigService;
}

describe('TicketService', () => {
  let service: TicketService;

  beforeEach(() => {
    service = new TicketService(makeConfig('unit-test-secret-1234567890'), new FakeRedis() as unknown as Redis);
  });

  it('issues a ticket that verifies back to the same email and a fresh jti', async () => {
    const { ticket, expiresIn } = await service.issue('alice@example.com', 'cid-1', null);
    expect(expiresIn).toBe(30);

    const claims = service.verify(ticket);
    expect(claims.email).toBe('alice@example.com');
    expect(claims.cid).toBe('cid-1');
    expect(claims.jti).toEqual(expect.any(String));
  });

  it('rejects a garbage ticket', () => {
    expect(() => service.verify('not-a-real-ticket')).toThrow(UnauthorizedException);
  });

  it('rejects a ticket signed with a different secret', async () => {
    const other = new TicketService(makeConfig('a-different-secret-1234567'), new FakeRedis() as unknown as Redis);
    const { ticket } = await other.issue('alice@example.com', 'cid-1', null);
    expect(() => service.verify(ticket)).toThrow(UnauthorizedException);
  });

  it('consume: first use wins, replay is rejected, and the stashed auth header is returned exactly once', async () => {
    const { ticket } = await service.issue('bob@example.com', 'cid-2', 'raw-bearer-token');
    const { jti } = service.verify(ticket);

    const first = await service.consume(jti, 30);
    expect(first).toEqual({ firstUse: true, authHeader: 'raw-bearer-token' });

    const second = await service.consume(jti, 30);
    expect(second).toEqual({ firstUse: false, authHeader: null });
  });

  it('consume: with no auth header stashed at issue time, firstUse still succeeds with authHeader null', async () => {
    const { ticket } = await service.issue('carol@example.com', 'cid-3', null);
    const { jti } = service.verify(ticket);

    const result = await service.consume(jti, 30);
    expect(result).toEqual({ firstUse: true, authHeader: null });
  });
});
