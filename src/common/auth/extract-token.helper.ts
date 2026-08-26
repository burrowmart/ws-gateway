/**
 * Shared by JwtGuard (inbound: mints a ticket) and TicketController (which
 * needs the raw token value to stash for later forwarding — see
 * TicketService.issue). Keeping the priority order in one place avoids the
 * two call sites silently drifting apart.
 */
export function extractBearerToken(headers: Record<string, string | undefined>): string | null {
  // Priority: Cloudflare-injected id_token → ALB OIDC header → standard Bearer
  if (headers['cf-token']) return headers['cf-token'] as string;
  if (headers['x-amzn-oidc-data']) return headers['x-amzn-oidc-data'] as string;
  const auth = headers['authorization'];
  if (auth?.startsWith('Bearer ')) return auth.slice(7);
  return null;
}
