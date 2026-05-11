# Deploying the Computeback MCP HTTP server

This service hosts the streamable-http transport of the Computeback MCP
server at `mcp.computeback.com/mcp`. The stdio binary on npm
(`computeback-mcp-server`) is unchanged and unrelated to this deploy.

## Prerequisites

- Railway CLI installed and authenticated (`railway login`).
- The `computeback` Railway project already exists (it hosts `backend`
  and the `house-agent` worker today).
- DNS for `computeback.com` is editable (Cloudflare / wherever the apex
  is hosted).

## 1. Create the Railway service

```bash
cd /Users/bidijaankassam/computeback/mcp-server
railway link               # pick the `computeback` project
railway service create mcp-http
railway service mcp-http   # select the new service for subsequent commands
```

## 2. Set env vars

Set these on the `mcp-http` Railway service. The MCP HTTP server itself
is a thin proxy — its only secret is the backend URL it forwards
authenticated requests to, plus the shared internal key it uses to call
the new `/v1/internal/verify-agent-signature` route on the backend.

| Var                       | Value                                                       | Notes                                                                                 |
| ------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `PORT`                    | `8080`                                                      | Railway maps this; matches `Dockerfile EXPOSE`.                                       |
| `HOST`                    | `0.0.0.0`                                                   | Listen on all interfaces.                                                             |
| `NODE_ENV`                | `production`                                                |                                                                                       |
| `COMPUTEBACK_API_URL`     | `https://backend-production-4100.up.railway.app/api`        | The backend service URL inside Railway. Switch to www.computeback.com/api in prod.    |
| `BASE_RPC_URL`            | `https://mainnet.base.org`                                  | Used by `check_balance` for on-chain reads. Set to your dedicated RPC if rate-limited. |
| `INTERNAL_API_KEY`        | (copy from backend service)                                 | Optional — only needed if MCP HTTP server calls the internal verify route directly.    |

The `AGENT_DID` / `AGENT_HMAC_SECRET` env vars used by the stdio binary
are NOT used here — the HTTP transport captures `X-Agent-Did` +
`X-Agent-Signature` headers from each incoming request.

```bash
railway variables --set PORT=8080
railway variables --set HOST=0.0.0.0
railway variables --set NODE_ENV=production
railway variables --set COMPUTEBACK_API_URL=https://backend-production-4100.up.railway.app/api
railway variables --set BASE_RPC_URL=https://mainnet.base.org
# Optional:
# railway variables --set INTERNAL_API_KEY=$(railway variables --service backend --kv | grep INTERNAL_API_KEY | cut -d= -f2)
```

## 3. Deploy

```bash
cd /Users/bidijaankassam/computeback/mcp-server
railway up --service mcp-http
```

Railway will detect the `railway.json` and build via the Dockerfile.
Expect the first build to take ~3 minutes (no cache); subsequent builds
~1 minute.

Verify after deploy:

```bash
curl https://<railway-generated-domain>/health
# → { "status": "ok", "service": "computeback-mcp-server", "transport": "streamable_http", "sessions": 0, ... }
```

## 4. Add the custom domain

In the Railway dashboard (or via the CLI):

1. Open the `mcp-http` service → Settings → Networking → Custom Domains.
2. Add `mcp.computeback.com`.
3. Railway will display a CNAME target like
   `<service>.up.railway.app`. Copy it.

## 5. Update DNS

In your DNS provider (Cloudflare for computeback.com):

```
Type:   CNAME
Name:   mcp
Value:  <service>.up.railway.app
Proxy:  DNS only (NOT proxied — streamable-http SSE doesn't work through
        Cloudflare's caching/proxy by default. Set proxy to gray cloud.)
TTL:    Auto
```

Wait ~2 minutes for DNS propagation, then verify:

```bash
curl https://mcp.computeback.com/health
curl https://mcp.computeback.com/.well-known/mcp.json
```

## 6. Smoke test the MCP endpoint

Without auth (storefront tool — should work):

```bash
curl -X POST https://mcp.computeback.com/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"1"}}}'
```

The response includes a `Mcp-Session-Id` header — grab it and reuse it
on the follow-up `tools/list` call:

```bash
SESSION_ID="<copy from header>"
curl -X POST https://mcp.computeback.com/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Mcp-Session-Id: $SESSION_ID" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
```

You should see all 28 tools.

For a CB Hire tool (auth required), include the agent headers — the
agent must have registered at `https://computeback.com/hire` to obtain
a DID + HMAC secret, then sign each request as documented in
`mcp-server/README.md`:

```bash
curl -X POST https://mcp.computeback.com/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Mcp-Session-Id: $SESSION_ID" \
  -H "X-Agent-Did: did:nomd:agt_..." \
  -H "X-Agent-Signature: <hex-hmac>" \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"list_my_inbox","arguments":{}}}'
```

## 7. Register the endpoint with directories

- **Anthropic Connector Directory**: submit at
  https://developer.anthropic.com — point at
  `https://mcp.computeback.com/.well-known/mcp.json` for discovery.
- **Smithery**: claim the namespace at https://smithery.ai/server/computeback.
- **OpenClaw**: pick up automatically via `.well-known/mcp.json`.

## Rollback

If anything's wrong:

```bash
railway service mcp-http
railway redeploy --previous   # or pin a previous deploy via the dashboard
```

The stdio binary on npm (`computeback-mcp-server@^1.0.0`) is unrelated
and unaffected — agents using local stdio MCP continue to work.

## Notes

- The session map lives in-process. Pin the `mcp-http` service to **1
  replica** in Railway → Settings → Resources. Beyond 1 replica, sessions
  break across instances; move to Redis (`REDIS_URL`) when scaling is
  required.
- CORS is wide open (`*`). The actual gate is the agent HMAC; opening
  CORS lets browser-based clients (claude.ai connectors) initiate
  sessions.
