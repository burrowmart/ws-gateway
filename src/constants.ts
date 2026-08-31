/** Single source of truth for all strings that change when cloning this template. */

/** Slug used for OTEL service.name, Helm release name, and image tag prefix. */
export const SERVICE_NAME = 'ws-gateway';

/** Path the WebSocket upgrade is handled on (see WsServerService). */
export const WS_PATH = '/ws';

/** Redis key prefix for single-use ticket consumption (SETNX + TTL). */
export const WS_TICKET_USED_KEY_PREFIX = 'ws:ticket:used:';

/**
 * Redis key prefix for the bearer token stashed at ticket-issue time.
 * chat-service and notification-service both require a real Cognito JWT on
 * every request (their Envoy PEPs verify it; no service-account bypass) —
 * the WS ticket only proves the handshake, so the gateway retains and
 * forwards the caller's original token for the lifetime of the connection.
 */
export const WS_TICKET_TOKEN_KEY_PREFIX = 'ws:ticket:token:';
