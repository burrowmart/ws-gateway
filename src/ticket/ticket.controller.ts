import { Controller, Post, Req } from '@nestjs/common';
import { ApiCreatedResponse, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import type { JwtPayload } from 'jsonwebtoken';
import { Claims } from '../common/auth/claims.decorator';
import { extractBearerToken } from '../common/auth/extract-token.helper';
import { getCorrelationId } from '../common/correlation/correlation.context';
import { TicketService } from './ticket.service';
import { TicketResponse } from './dto/ticket.response';

@ApiTags('ticket')
@Controller('ws/ticket')
export class TicketController {
  constructor(private readonly tickets: TicketService) {}

  // Guarded by the default APP_GUARD (JwtGuard, from CommonModule) — the caller
  // must already hold a valid Cognito JWT. The ticket is bound to that verified
  // email, not anything the client claims in the request body.
  @Post()
  @ApiCreatedResponse({ type: TicketResponse, description: 'Mints a 30s single-use WS handshake ticket' })
  issue(@Claims() claims: JwtPayload, @Req() req: Request): Promise<TicketResponse> {
    // Falls back to a fresh id only if this request truly has none (defensive;
    // CorrelationInterceptor always sets one in practice) — the ticket must
    // always carry a cid so it can propagate into the WS connection's logs.
    const correlationId = getCorrelationId() ?? 'unknown';
    // Stashed (not embedded in the ticket) so it can be forwarded to
    // chat-service/notification-service for the life of the WS connection —
    // both require this same caller-verified Cognito JWT on every request.
    const authHeader = extractBearerToken(req.headers as Record<string, string | undefined>);
    return this.tickets.issue(claims.email as string, correlationId, authHeader);
  }
}
