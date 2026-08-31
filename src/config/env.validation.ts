import * as Joi from 'joi';
import { SERVICE_NAME } from '../constants';

export const envValidationSchema = Joi.object({
  PORT: Joi.number().default(3000),
  NODE_ENV: Joi.string().valid('development', 'test', 'production').default('development'),
  // Test-only identity bypass — the guard only extracts identity, never
  // verifies signatures (that is the Envoy PEP's job; see jwt.guard.ts)
  AUTH_DISABLED: Joi.string().valid('true', 'false').default('false'),
  // Observability
  OTEL_EXPORTER_OTLP_ENDPOINT: Joi.string().uri().optional(),
  OTEL_SERVICE_NAME: Joi.string().default(SERVICE_NAME),
  // Redis — pub/sub fan-out backbone and single-use ticket store
  REDIS_URL: Joi.string().default('redis://localhost:6379'),
  // Ticket signing — always required, even with AUTH_DISABLED, since the WS
  // handshake itself has no other guard
  WS_TICKET_SECRET: Joi.string().min(16).required(),
  WS_TICKET_TTL_SECONDS: Joi.number().default(30),
  WS_HEARTBEAT_INTERVAL_MS: Joi.number().default(30000),
  WS_IDLE_TIMEOUT_MS: Joi.number().default(70000),
  // Upstream REST services this gateway calls on channel-join / resume
  CHAT_SERVICE_URL: Joi.string().default('http://localhost:3002'),
  NOTIFICATION_SERVICE_URL: Joi.string().default('http://localhost:3004'),
});
