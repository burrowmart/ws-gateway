export default () => ({
  port: parseInt(process.env.PORT ?? '3000', 10),
  cognito: {
    issuer: process.env.COGNITO_ISSUER ?? '',
    audience: process.env.COGNITO_AUDIENCE ?? '',
  },
  redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6379',
  // HMAC secret signing the short-lived handshake ticket minted by POST /ws/ticket.
  wsTicketSecret: process.env.WS_TICKET_SECRET as string,
  wsTicketTtlSeconds: parseInt(process.env.WS_TICKET_TTL_SECONDS ?? '30', 10),
  // REST bases for the two upstream services ws-gateway calls on channel-join
  // (membership check, resume replay) — never for domain writes.
  chatServiceUrl: process.env.CHAT_SERVICE_URL ?? 'http://localhost:3002',
  notificationServiceUrl: process.env.NOTIFICATION_SERVICE_URL ?? 'http://localhost:3004',
  ws: {
    heartbeatIntervalMs: parseInt(process.env.WS_HEARTBEAT_INTERVAL_MS ?? '30000', 10),
    // Connection is terminated if no pong is seen for this long — must be
    // greater than heartbeatIntervalMs to allow at least one missed beat
    // for network jitter before declaring the socket dead.
    idleTimeoutMs: parseInt(process.env.WS_IDLE_TIMEOUT_MS ?? '70000', 10),
  },
});
