import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import * as jwt from 'jsonwebtoken';
import Redis from 'ioredis';
import { WS_REDIS_CLIENT } from '../redis/redis.tokens';
import { WS_TICKET_TOKEN_KEY_PREFIX, WS_TICKET_USED_KEY_PREFIX } from '../constants';

export interface TicketClaims {
  /** Subject the ticket is bound to — the WS connection is authenticated as this email. */
  email: string;
  /** Single-use identifier — consumed via Redis SETNX on the WS handshake. */
  jti: string;
  /** correlationId of the POST /ws/ticket request, carried into WS logs. */
  cid: string;
}

export interface ConsumeResult {
  /** false means the ticket was already used (or never existed) — reject with 4401. */
  firstUse: boolean;
  /** The caller's original bearer token, stashed at issue time — null if absent/expired. */
  authHeader: string | null;
}

const usedKey = (jti: string) => `${WS_TICKET_USED_KEY_PREFIX}${jti}`;
const tokenKey = (jti: string) => `${WS_TICKET_TOKEN_KEY_PREFIX}${jti}`;

/**
 * Mints and verifies the short-lived handshake ticket. HMAC (not JWKS/RS256)
 * because this token is minted and verified by the same process on the same
 * secret — there is no third party that needs to independently trust it, unlike
 * the Cognito JWT the ticket request itself is already gated behind.
 */
@Injectable()
export class TicketService {
  constructor(
    private readonly config: ConfigService,
    @Inject(WS_REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  async issue(
    email: string,
    correlationId: string,
    authHeader: string | null,
  ): Promise<{ ticket: string; expiresIn: number }> {
    const ttl = this.config.get<number>('wsTicketTtlSeconds')!;
    const secret = this.config.get<string>('wsTicketSecret')!;
    const claims: TicketClaims = { email, jti: randomUUID(), cid: correlationId };
    const ticket = jwt.sign(claims, secret, { expiresIn: ttl, algorithm: 'HS256' });

    // Stashed server-side only — never re-embedded in the ticket itself, which
    // travels as a WS handshake query param and ends up in access logs/URLs.
    if (authHeader) {
      await this.redis.set(tokenKey(claims.jti), authHeader, 'EX', ttl);
    }

    return { ticket, expiresIn: ttl };
  }

  verify(ticket: string): TicketClaims {
    const secret = this.config.get<string>('wsTicketSecret')!;
    try {
      const decoded = jwt.verify(ticket, secret, { algorithms: ['HS256'] });
      if (typeof decoded === 'string') throw new Error('unexpected string payload');
      const { email, jti, cid } = decoded as jwt.JwtPayload & Partial<TicketClaims>;
      if (!email || !jti || !cid) throw new Error('ticket missing required claims');
      return { email, jti, cid };
    } catch (err) {
      throw new UnauthorizedException(`Invalid or expired ticket: ${(err as Error).message}`);
    }
  }

  /**
   * Atomically claims single-use, then retrieves (and deletes) the stashed
   * token. SETNX is the single source of truth for "already used" — a
   * concurrent replay loses the race and gets firstUse:false, never a token.
   */
  async consume(jti: string, ttlSeconds: number): Promise<ConsumeResult> {
    const claimed = await this.redis.set(usedKey(jti), '1', 'EX', ttlSeconds, 'NX');
    if (claimed !== 'OK') return { firstUse: false, authHeader: null };

    const authHeader = await this.redis.getdel(tokenKey(jti));
    return { firstUse: true, authHeader };
  }
}
