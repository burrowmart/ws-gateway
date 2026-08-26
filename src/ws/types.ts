import type WebSocket from 'ws';

export type Channel = 'notifications' | `chat:${string}`;

export interface ClientFrame {
  channel: Channel;
  action: 'join' | 'leave';
  payload?: {
    /** chat:* → last-seen numeric seq. notifications → last-seen ISO createdAt. */
    lastSeen?: number | string;
  };
}

export type ServerAction = 'ack' | 'replay' | 'event' | 'error';

export interface ServerFrame {
  channel: Channel;
  action: ServerAction;
  payload: Record<string, unknown> | { reason: string };
}

export interface ConnectionMeta {
  email: string;
  /** correlationId of the POST /ws/ticket request — propagated into every log line for this connection. */
  cid: string;
  /** Forwarded as `Authorization: Bearer <token>` on REST calls made for this connection's lifetime. */
  authHeader: string | null;
  /** Updated on every pong; the heartbeat loop terminates the socket once this goes stale. */
  lastPongAt: number;
  /** Channels this specific socket has joined — used to clean up ref-counts on close. */
  subscriptions: Set<Channel>;
  /**
   * Presence of a channel key here means "resume in progress — buffer, don't
   * deliver": RedisFanoutService checks this before every delivery. The
   * channel router creates the entry before subscribing and removes it (after
   * flushing the buffered frames) once the replay fetch completes, so a live
   * message that arrives mid-fetch is queued instead of jumping ahead of
   * history that hasn't been sent yet.
   */
  replayBuffers: Map<Channel, ServerFrame[]>;
}

export type AuthedSocket = WebSocket & { meta: ConnectionMeta };
