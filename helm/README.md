# ws-gateway Helm chart

Inherits all Kubernetes object templates from `platform-infra/helm/base-service`
via a chart dependency. Only service-specific values live here — including the
WebSocket-enabling overrides this service is the sole consumer of.

## Prerequisites

| Tool | Version |
|------|---------|
| Helm | ≥ 3.12 |
| kubectl | ≥ 1.28 |
| External Secrets Operator | installed in cluster |
| `aws-secrets-manager` ClusterSecretStore | pre-provisioned by platform-infra Terraform |

---

## Render (dry-run, no cluster required)

```bash
# 1. Fetch the base-service dependency (creates charts/base-service-0.1.0.tgz)
helm dependency update ./ws-gateway/helm

# 2. Lint
helm lint ./ws-gateway/helm

# 3. Render to stdout — inspect the full manifest before applying
helm template ws-gateway ./ws-gateway/helm

# 4. Render with a specific image tag (mirrors what CI does)
helm template ws-gateway ./ws-gateway/helm \
  --set base-service.image.tag=sha-$(git rev-parse --short HEAD)
```

---

## Deploy to EKS

```bash
aws eks update-kubeconfig --name <cluster-name> --region <region>

helm upgrade --install ws-gateway ./ws-gateway/helm \
  --namespace ws-gateway \
  --create-namespace \
  --set base-service.image.tag=sha-<git-sha> \
  --set base-service.irsaRoleArn=arn:aws:iam::<ACCOUNT_ID>:role/ws-gateway-irsa \
  --wait
```

---

## Key values reference

| Value | Default | Notes |
|-------|---------|-------|
| `base-service.envoy.websocketUpgrade` | `true` | Base chart's opt-in — only ws-gateway sets this |
| `base-service.envoy.routeTimeoutSeconds` | `3600` | Never `0` — Sprig's `default` treats it as empty |
| `base-service.ingress.annotations` | proxy-read/send-timeout `3600`, buffering `off` | Merged over the base chart's 60s/30s defaults |
| `base-service.image.tag` | `latest` | CI sets this to the git SHA |
| `base-service.secretsManagerPath` | `/prod/ws-gateway` | Must contain: `REDIS_URL`, `WS_TICKET_SECRET` |
| `base-service.opaAddress` | `opa-pdp.opa-system.svc.cluster.local:9191` | OPA DaemonSet ClusterIP; `failure_mode_allow: false` enforced |
| `base-service.ingress.host` | `ws-gateway.internal.archtenet.com` | Internal only — Cloudflare Tunnel entry point |
| `base-service.replicaCount` | `2` | HPA overrides at runtime (min 2, max 10) |

---

## Why this chart needs the websocket overrides

The base chart's Envoy sidecar config has no `upgrade_configs` and a
hardcoded 30s route timeout by default — correct for every request/response
service, fatal for a WebSocket. Without `envoy.websocketUpgrade: true`, Envoy
strips the `Upgrade` header and the handshake fails as a plain HTTP request.
The nginx Ingress defaults (60s read timeout) have the same problem one hop
further out. Both overrides are additive to the shared base chart (default
off/empty) — every other service's rendered manifests are byte-for-byte
unaffected.

## Envoy / OPA authorization

Same PEP sidecar pattern as every other service — `ext_authz` over gRPC to
the OPA DaemonSet before the request reaches the app container:

```
Cloudflare Tunnel → nginx-internal Ingress → Service:80 → envoy-pep:8080
  → ext_authz gRPC → OPA DaemonSet:9191
  → app:3000 (on allow) — handles POST /ws/ticket and the WS Upgrade at /ws
```

OPA authorizes the HTTP-level handshake request once; it has no visibility
into individual WS frames after that — the single-use ticket is what
actually gates the connection (see the top-level README).

## Secrets

AWS Secrets Manager document `/prod/ws-gateway` is synced into a k8s Secret
by External Secrets Operator. The ServiceAccount carries the IRSA annotation
`eks.amazonaws.com/role-arn: <irsaRoleArn>` so the pod's AWS API calls are
authenticated without static credentials. No secret values appear in this
chart.
