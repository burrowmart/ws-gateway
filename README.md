# ws-gateway

The realtime edge for the @demo platform: one multiplexed WebSocket per client,
gated by a short-lived single-use handshake ticket, fanning out messages
published by `chat-service` and `notification-service` over Redis pub/sub to the
socket(s) that hold the right user.

This is the **only** place in the system that opens a server-side WebSocket, and
it routes bytes — no Mongoose model, no outbox, no REST domain API, no domain
logic of its own.

Scaffolded from `user-service`; see [`platform-infra`](../platform-infra) for the
shared pieces that come with it — auth guard, correlation id, pino logging, OTel
tracing, Prometheus metrics, Helm chart, CI.

## Architecture

### HTTP surface

Everything except `/ws` is plain HTTP served by Nest. The WebSocket is attached
to the same `http.Server` in `noServer` mode, so Express never sees upgrade
traffic (see [`ws-server.service.ts`](src/ws/ws-server.service.ts)).

| Route | Auth | Notes |
|---|---|---|
| `POST /ws/ticket` | Cognito JWT (global `JwtGuard`) | mints the handshake ticket; `201` |
| `GET /ws` (Upgrade) | ticket query param only | the WebSocket itself — not in `openapi.yaml` |
| `GET /health` | public | `{ status: "ok" }` |
| `GET /metrics` | public | Prometheus text format |
| `GET /api` | public | Swagger UI (blocked in prod by the Envoy PEP path allow-list) |

### What this service owns

| Resource | Type | Notes |
|----------|------|-------|
| `ws:ticket:used:{jti}` | Redis key, TTL = ticket TTL | single-use marker (SETNX) |
| `ws:ticket:token:{jti}` | Redis key, TTL = ticket TTL | caller's bearer token, stashed at ticket-issue time, consumed (GETDEL) once at connect |
| in-process `email → Set<socket>` | memory, per-pod | connection registry — multi-device |
| in-process `redisChannel → Set<socket>` | memory, per-pod | ref-counted local fan-out targets |

It owns no MongoDB collection and no outbox — nothing here is durable. If this
pod restarts, every connection it held reconnects and resumes via `lastSeen`.

### Ticket auth

TTL below is `WS_TICKET_TTL_SECONDS` (default `30`) throughout — the ticket
expiry, both Redis keys' TTL, and the `expiresIn` field are all the same value.

```
POST /ws/ticket                         (Cognito JWT required — the standard guard)
  → TicketService.issue(email, cid, callerBearerToken)
    - signs {email, jti, cid} HS256, expiry = WS_TICKET_TTL_SECONDS
    - stashes callerBearerToken in Redis, keyed by jti, same TTL
      (only if the caller actually presented one — otherwise nothing is stashed)
  → { ticket, expiresIn }

wss://.../ws?ticket=...
  → TicketService.verify(ticket)              signature + expiry + required claims
  → TicketService.consume(jti, ttlSeconds)    Redis SETNX — first use wins
    - firstUse: false  → ws.close(4401, ...)
    - firstUse: true   → GETDEL the stashed bearer token, hold it for this
                          connection's lifetime (forwarded as `Authorization:
                          Bearer` on every chat-service/notification-service
                          call this connection makes — those services run the
                          same global Cognito-JWT guard as everything else in
                          this system, and the WS ticket alone doesn't satisfy it)
```

The ticket is HMAC (HS256), not RS256/JWKS, because it is minted and verified by
the same process on the same secret — no third party needs to independently
trust it, unlike the Cognito JWT the ticket request is itself gated behind.

The bearer token is stashed server-side rather than embedded in the ticket: the
ticket travels as a WS handshake **query param**, which lands in access logs and
proxy URLs.

### Client frame protocol

Single JSON text-frame envelope both directions: `{ channel, action, payload? }`.

| Dir | Field | Type | Notes |
|---|---|---|---|
| → | `channel` | `string` | `"notifications"` or `"chat:{conversationId}"` |
| → | `action` | `"join" \| "leave"` | subscribe/unsubscribe to `channel` |
| → | `payload.lastSeen` | `number` (chat) / `string` ISO (notifications) | optional, only with `action:"join"`; triggers resume-replay before live traffic |
| ← | `channel` | `string` | echoes the channel the frame concerns |
| ← | `action` | `"ack" \| "replay" \| "event" \| "error"` | `ack`: join/leave confirmed · `replay`: historical item, delivered in order · `event`: live item · `error`: see below |
| ← | `payload` | `object` | `ack`: `{}` · `replay`/`event`: the chat message or notification object as persisted upstream · `error`: `{ reason }` — see the table below |

#### Error reasons

| `reason` | When | Does the join still complete? |
|---|---|---|
| `invalid_frame` | the frame isn't JSON, isn't an object, has an unknown `channel`, or an `action` other than `join`/`leave` | n/a — nothing was parsed |
| `not_a_member` | `chat:*` join where chat-service returns 404 for the member check, **or** the member check itself throws (upstream down is reported as not-a-member, not `upstream_unavailable`) | no — returns early, no subscribe, no replay, no `ack` |
| `upstream_unavailable` | the resume replay fetch failed after the subscription was already established | yes — an `ack` still follows and live traffic flows; only the history is missing |

Because a malformed frame has no parseable channel, the `invalid_frame` error is
always emitted on channel `"notifications"` regardless of what the client sent.
A client that multiplexes several channels can't attribute it — treat it as a
connection-level error, not a channel-level one.

Heartbeat is protocol-level (native WS ping/pong control frames, not JSON):
server pings every `WS_HEARTBEAT_INTERVAL_MS` (default 30s), terminates the
socket once `WS_IDLE_TIMEOUT_MS` (default 70s) passes with no pong. The idle
timeout must stay greater than the ping interval so one missed beat to jitter
doesn't kill a live connection.

Close codes: `4401` missing / bad / expired / reused ticket, `1000` normal. The
handshake is deliberately completed before a 4401 close, so the client gets a
real WS `close` event carrying the code — a raw HTTP 401 would surface only as
an opaque connection failure.

### Join flow (chat:*)

```
{channel:"chat:c1", action:"join", payload:{lastSeen:7}}
  → ChatUpstreamService.checkMembership(c1, email)   GET chat-service /conversations/c1/members/{email}
    - 404 or throw → {action:"error", payload:{reason:"not_a_member"}} — no subscribe, no replay
    - 200 → continue
  → open socket.meta.replayBuffers["chat:c1"] = []    (live traffic queues here, doesn't jump ahead)
  → RedisFanoutService.subscribe("chat:c1")           ref-counted — one Redis SUBSCRIBE per conversation, not per socket
  → ChatUpstreamService.listAfterSeq(c1, 7)           GET chat-service /conversations/c1/messages?afterSeq=7
  → replay each message in order                       {action:"replay", ...}
  → flush anything that queued during the fetch above   {action:"event", ...}
  → {action:"ack"}
```

`notifications` skips the membership check (it's always the caller's own
channel — derived from the authenticated connection, never client-supplied)
but otherwise follows the identical buffer → subscribe → replay → flush → ack
sequence, resuming against notification-service's `GET /notifications`.

Omitting `payload.lastSeen` skips the replay step entirely: the join is
buffer → subscribe → flush → ack, and the client gets live traffic only.

#### Replay is a single page, not a cursor loop

Both resume paths fetch exactly one upstream page — demo-scale, deliberately:

- **chat**: `GET /conversations/{id}/messages?afterSeq={lastSeen}&limit=500`.
  chat-service sorts ascending by `seq`, so the page replays as-is. A client
  more than 500 messages behind silently gets only the oldest 500 of the gap.
- **notifications**: notification-service has no `afterSeq`/`afterId` filter —
  it's a flat newest-first list. Resume pulls `limit=200`, reverses to
  ascending, and filters client-side on `createdAt > lastSeen` (ISO strings
  sort lexicographically). More than 200 notifications since `lastSeen` and
  the overflow is missed.

Neither cap is a durability guarantee — the durable journals live in
chat-service and notification-service, and a client that has fallen further
behind than this should page their REST APIs directly rather than resume
through the socket.

### Fan-out

Redis pub/sub subscriptions are ref-counted **by the actual Redis channel**,
not the client-facing name — `notifications` is per-user on Redis
(`notifications:{email}`) even though every client just sends `"notifications"`;
keying by the client-facing string would leak one user's push to every other
locally-connected user. `chat:{conversationId}` is already conversation-scoped
and identical on both sides, so three local participants still cost exactly
one `SUBSCRIBE chat:{id}` — dropped only once the last of them leaves.

Non-JSON pub/sub payloads are logged and dropped, never forwarded.

---

## Running locally

### Prerequisites

```bash
# 1. Build the shared contracts package
cd ../contracts && npm install && npm run build && cd -

# 2. Install service dependencies
npm install

# 3. Copy env and start the Redis compose stack (no Mongo — this service has no collection)
cp .env.example .env
docker compose -f ../platform-infra/docker-compose.yml up -d redis

# 4. Bypass Cognito locally — .env.example ships AUTH_DISABLED=false, and the
#    curl below won't authenticate until you flip it.
#    (WS_TICKET_SECRET is still required either way — the handshake has no
#    other guard, so it is validated even with auth disabled.)
sed -i '' 's/^AUTH_DISABLED=false/AUTH_DISABLED=true/' .env
```

`ws-gateway` calls chat-service and notification-service over REST for
membership checks and resume replay, so run both if you want `join` to work.
Both default to `PORT=3000` in their own `.env.example`, which collides with
this service and with the defaults here — start them on the ports
`.env.example` expects (`CHAT_SERVICE_URL=http://localhost:3002`,
`NOTIFICATION_SERVICE_URL=http://localhost:3004`), or point these two vars at
wherever you actually ran them:

```bash
cd ../chat-service         && PORT=3002 npm run start:dev
cd ../notification-service && PORT=3004 npm run start:dev
```

Without them the gateway still starts and the socket still connects — joins
just fail (`not_a_member` on `chat:*`, `upstream_unavailable` on a
`notifications` resume).

### Start in dev mode

```bash
npm run start:dev
# HTTP (ticket issuance, health, Swagger) on http://localhost:3000
# Swagger UI at                              http://localhost:3000/api
# WebSocket handshake on                     ws://localhost:3000/ws?ticket=...
```

### Build

```bash
npm run build
# Output in dist/ — run it with `npm start`
```

### Tests

```bash
# Unit tests — ticket signing/consume (in-memory Redis fake) and frame parsing.
# No external dependencies.
npm test

# E2E — real Redis (REDIS_URL, default redis://localhost:6379) for actual
# pub/sub fan-out; chat-service/notification-service are stubbed in-process
# with just enough surface to match their real REST contract (see
# test/support/upstream-stub.ts) so the suite doesn't need those repos
# checked out to run.
docker compose -f ../platform-infra/docker-compose.yml up -d redis
npm run test:e2e
```

The e2e suite covers multi-device fan-out, per-conversation isolation,
replay-before-live ordering under a deliberately slowed resume fetch, and
4401 on both an invalid and a reused ticket.

### Generate openapi.yaml

```bash
npm run generate:openapi
```

Only `/health` and `POST /ws/ticket` appear — the WebSocket is not an HTTP
endpoint and has no OpenAPI representation. The frame protocol above is its
contract.

### curl round-trip

```bash
BASE=http://localhost:3000

# Mint a ticket (AUTH_DISABLED=true — x-test-user-email picks the identity)
curl -s -X POST $BASE/ws/ticket -H 'x-test-user-email: alice@example.com' | jq
```

Then connect with any WS client to `ws://localhost:3000/ws?ticket=<ticket>`
and send `{"channel":"notifications","action":"join"}`. The ticket is
single-use — reconnecting means minting a fresh one.

---

## Configuration

See [.env.example](.env.example) for the full list. Notable ones:

| Var | Purpose |
|---|---|
| `WS_TICKET_SECRET` | HMAC secret for the handshake ticket, min 16 chars — **required even with `AUTH_DISABLED=true`**, since the WS upgrade has no other guard |
| `WS_TICKET_TTL_SECONDS` | ticket expiry, and the TTL of both `ws:ticket:*` Redis keys (default `30`) |
| `WS_HEARTBEAT_INTERVAL_MS` / `WS_IDLE_TIMEOUT_MS` | ping cadence and no-pong termination window; the timeout must exceed the interval (defaults `30000` / `70000`) |
| `REDIS_URL` | pub/sub fan-out backbone **and** the single-use ticket store — there is no Mongo here |
| `CHAT_SERVICE_URL` / `NOTIFICATION_SERVICE_URL` | REST bases called on channel-join (membership) and resume (replay) — never for domain writes |
| `AUTH_DISABLED` | skip identity extraction on `POST /ws/ticket` (local/test only); `x-test-user-email` then picks the identity. Signature verification lives in the Envoy PEP, not here |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | blank = spans print to stdout via `ConsoleSpanExporter` |

## Deployment

Built via the multi-stage [Dockerfile](Dockerfile) (build context is the
`backend/` repo root, since it also compiles the `@demo/contracts` package —
and unlike every other service, ws-gateway imports *runtime* values from
`@demo/contracts/clients`, so the contracts `dist/` must exist in the runtime
image, not just at compile time).

Deployed with the Helm chart in [helm/](helm/), layered on `base-service` with
an Envoy PEP sidecar in front (OPA `ext_authz`, `failure_mode_allow: false`).
This is the only chart in the system that turns on the base chart's opt-in
WebSocket support:

- `envoy.websocketUpgrade: true` — without the HCM/route `upgrade_configs`,
  Envoy strips the `Upgrade` header and every handshake fails as plain HTTP.
- `envoy.routeTimeoutSeconds: 3600` and the nginx `proxy-read-timeout` /
  `proxy-send-timeout` / `proxy-buffering: off` ingress annotations — the base
  chart's 60s/30s defaults would drop an idle-but-alive socket well before the
  app-level heartbeat ever fires.
- `autoscaling.targetCPUUtilizationPercentage: 70`, lower than the
  request/response services — connections are pinned to whichever pod accepted
  the handshake, so scale-in is a hard disconnect for its holders; the lower
  target makes eviction rarer, it isn't a claim about CPU profile.

CI (`.github/workflows/ci.yml`) delegates to `platform-infra`'s reusable
`service-ci.yml`.
