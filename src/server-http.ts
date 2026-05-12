#!/usr/bin/env node
/**
 * Computeback MCP server — Streamable HTTP transport.
 *
 * Hosted at https://mcp.computeback.com/mcp once deployed. Endpoints:
 *   POST/GET/DELETE /mcp     — MCP JSON-RPC over streamable HTTP
 *   GET             /health  — liveness probe (Railway)
 *   GET             /        — friendly root hint
 *   GET             /.well-known/mcp.json — discovery manifest
 *
 * Per-session lifecycle
 * ---------------------
 *   1. Client POSTs an `initialize` request with NO Mcp-Session-Id.
 *      We mint a session id, capture any `x-agent-did` / `x-agent-signature`
 *      headers off this first request, build an McpServer scoped to this
 *      session, and respond with the session id in the Mcp-Session-Id
 *      header (StreamableHTTPServerTransport handles the header injection).
 *   2. Subsequent requests carry the session id. Each request's auth
 *      headers REPLACE the session's stored auth headers — so an agent
 *      can rotate creds mid-session if needed, but the common case is the
 *      headers are sent on every request anyway.
 *   3. Tools that talk to the Computeback backend forward those captured
 *      headers downstream. The backend (`requireAgentAuth` middleware in
 *      backend/src/lib/agent-auth.ts) is the canonical signature verifier.
 *   4. DELETE /mcp closes the session.
 *
 * Trust model
 * -----------
 * The MCP HTTP server is STATELESS from a security standpoint — it does
 * NOT validate signatures itself. It captures the per-request headers
 * and forwards them to the backend, which is the single source of
 * verification truth. Storefront tools (read-only, no auth required by
 * the backend) work without headers; CB Hire tools reject locally via
 * `authCtx.requireAuth()` if no headers are present, returning a clean
 * MCP error rather than letting the backend respond with a noisy 401.
 *
 * Stateless caveat
 * ----------------
 * The session map lives in process memory. If we ever scale beyond 1
 * Railway replica, sessions break across instances. Pin to 1 replica
 * and move sessions to Redis when scaling is needed.
 */
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { buildServer, type AuthContext, type AgentAuthHeaders, CB_HIRE_TOOL_NAMES, STOREFRONT_TOOL_NAMES } from "./server-core.js";

const PORT = parseInt(process.env.PORT || "8080", 10);
const HOST = process.env.HOST || "0.0.0.0";

interface SessionState {
  transport: StreamableHTTPServerTransport;
  /** Latest captured auth headers (mutated on every request). */
  auth: AgentAuthHeaders | null;
  createdAt: number;
  lastSeenAt: number;
}

const sessions = new Map<string, SessionState>();

// Periodic sweep — drop sessions with no traffic for 30 minutes.
const SESSION_TTL_MS = 30 * 60_000;
setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now - s.lastSeenAt > SESSION_TTL_MS) {
      try { s.transport.close(); } catch { /* best effort */ }
      sessions.delete(id);
    }
  }
}, 60_000);

// ---------------------------------------------------------------------------
// Helpers — read body, write JSON, CORS
// ---------------------------------------------------------------------------

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Mcp-Session-Id, Authorization, X-Agent-Did, X-Agent-Signature, X-Agent-Timestamp",
  "Access-Control-Expose-Headers": "Mcp-Session-Id",
  "Access-Control-Max-Age": "86400",
};

function applyCors(res: ServerResponse): void {
  for (const [k, v] of Object.entries(CORS_HEADERS)) res.setHeader(k, v);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  applyCors(res);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (chunks.length === 0) return undefined;
  const raw = Buffer.concat(chunks).toString("utf-8");
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("Invalid JSON body");
  }
}

function getHeader(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name.toLowerCase()];
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v[0];
  return undefined;
}

function captureAuthHeaders(req: IncomingMessage): AgentAuthHeaders | null {
  const did = getHeader(req, "x-agent-did");
  const signature = getHeader(req, "x-agent-signature");
  const timestamp = getHeader(req, "x-agent-timestamp");
  if (!did) return null;
  return { did, signature: signature ?? "", timestamp: timestamp ?? undefined };
}

// ---------------------------------------------------------------------------
// Build a per-session AuthContext that reads from the session's captured
// headers at call-time (not at server-build time), so header rotation
// mid-session is supported.
// ---------------------------------------------------------------------------

function makeSessionAuthContext(getAuth: () => AgentAuthHeaders | null): AuthContext {
  return {
    getAuthHeaders(_path: string): AgentAuthHeaders | null {
      return getAuth();
    },
    requireAuth(toolName: string): void {
      const auth = getAuth();
      if (!auth || !auth.did) {
        throw new Error(
          `Tool "${toolName}" requires agent auth. Send X-Agent-Did + X-Agent-Signature headers on the MCP request. Register at https://computeback.com/hire to mint a DID + secret.`,
        );
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

function handleHealth(_req: IncomingMessage, res: ServerResponse): void {
  sendJson(res, 200, {
    status: "ok",
    service: "@autonomad1/computeback-mcp",
    transport: "streamable_http",
    sessions: sessions.size,
    uptime_s: Math.round(process.uptime()),
  });
}

function handleRoot(_req: IncomingMessage, res: ServerResponse): void {
  sendJson(res, 200, {
    service: "Computeback MCP Server",
    transport: "streamable_http",
    endpoints: {
      mcp: "/mcp",
      health: "/health",
      manifest: "/.well-known/mcp.json",
    },
    documentation: "https://www.computeback.com/hire",
  });
}

function handleManifest(_req: IncomingMessage, res: ServerResponse): void {
  sendJson(res, 200, {
    schema_version: "1.0",
    name: "computeback",
    version: "1.1.3",
    title: "Computeback — Agent Marketplace + CB Hire",
    description:
      "Two-sided MCP server for autonomous agents: (1) browse and buy capabilities — compute, voice, memory, storage, and 25+ categories — using $NOMD tokens on Base L2; (2) discover and execute paid B2B labor through CB Hire — email outreach, voice campaigns, SMS, conversational landing pages, multi-channel workflows — earning $NOMD on completion.",
    vendor: "Computeback by Autonomad",
    homepage: "https://www.computeback.com",
    documentation: "https://www.computeback.com/hire",
    support: { email: "disrupt@autonomad.ai", url: "https://www.computeback.com/hire" },
    transport: "streamable-http",
    endpoint: "https://mcp.computeback.com/mcp",
    authentication: "hmac_per_request",
    auth_headers: ["X-Agent-Did", "X-Agent-Signature", "X-Agent-Timestamp"],
    auth_registration: "https://www.computeback.com/hire",
    capabilities: ["tools"],
    tools: [...STOREFRONT_TOOL_NAMES, ...CB_HIRE_TOOL_NAMES],
    no_auth_tools: STOREFRONT_TOOL_NAMES,
    auth_required_tools: CB_HIRE_TOOL_NAMES,
    categories: ["marketplace", "agent-economy", "b2b", "ai-tools"],
  });
}

async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  // Disable buffering for any SSE responses — Railway's edge proxy may
  // otherwise hold chunks until the response closes.
  res.setHeader("X-Accel-Buffering", "no");
  applyCors(res);

  const sessionId = getHeader(req, "mcp-session-id");
  const auth = captureAuthHeaders(req);

  let body: unknown;
  if (req.method === "POST") {
    try {
      body = await readJsonBody(req);
    } catch (err: any) {
      return sendJson(res, 400, {
        jsonrpc: "2.0",
        error: { code: -32700, message: err?.message || "Parse error" },
        id: null,
      });
    }
  }

  // Reuse an existing session
  if (sessionId && sessions.has(sessionId)) {
    const state = sessions.get(sessionId)!;
    state.lastSeenAt = Date.now();
    if (auth) state.auth = auth; // header rotation
    return state.transport.handleRequest(req, res, body);
  }

  // Session ID provided but unknown — server probably restarted. Per MCP
  // spec the right signal is 404 so compliant clients re-issue
  // initialize. Returning 400 would leave clients stuck on stale ids.
  if (sessionId) {
    return sendJson(res, 404, {
      jsonrpc: "2.0",
      error: {
        code: -32001,
        message: "Session not found — server has restarted. Reissue an initialize request to start a new session.",
      },
      id: null,
    });
  }

  // POST without session id → must be an initialize call
  if (req.method === "POST" && isInitializeRequest(body)) {
    const newSessionId = randomUUID();
    const state: SessionState = {
      transport: null as unknown as StreamableHTTPServerTransport,
      auth,
      createdAt: Date.now(),
      lastSeenAt: Date.now(),
    };
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => newSessionId,
      onsessioninitialized: (id) => {
        console.log(`[mcp-http] Session ${id} initialized (did=${auth?.did ? auth.did.slice(0, 16) + "…" : "anon"})`);
      },
    });
    transport.onclose = () => {
      const id = transport.sessionId;
      if (id && sessions.has(id)) {
        sessions.delete(id);
        console.log(`[mcp-http] Session ${id} closed (remaining=${sessions.size})`);
      }
    };

    const authCtx = makeSessionAuthContext(() => state.auth);
    const mcpServer = buildServer(authCtx);
    await mcpServer.connect(transport);
    state.transport = transport;
    sessions.set(newSessionId, state);
    return transport.handleRequest(req, res, body);
  }

  // Anything else without a recognized session is a 400.
  return sendJson(res, 400, {
    jsonrpc: "2.0",
    error: {
      code: -32000,
      message: "Bad Request: No valid session ID provided. Send an initialize request first.",
    },
    id: null,
  });
}

// ---------------------------------------------------------------------------
// HTTP listener
// ---------------------------------------------------------------------------

const server = createServer(async (req, res) => {
  // CORS preflight
  if (req.method === "OPTIONS") {
    applyCors(res);
    res.statusCode = 204;
    return res.end();
  }

  const url = req.url || "/";
  const path = url.split("?")[0];

  try {
    if (path === "/health" && req.method === "GET") return handleHealth(req, res);
    if (path === "/" && req.method === "GET") return handleRoot(req, res);
    if (path === "/.well-known/mcp.json" && req.method === "GET") return handleManifest(req, res);
    if (path === "/favicon.ico") {
      res.statusCode = 301;
      res.setHeader("Location", "https://www.computeback.com/favicon.ico");
      return res.end();
    }
    if (path === "/mcp") return handleMcp(req, res);

    return sendJson(res, 404, {
      jsonrpc: "2.0",
      error: { code: -32601, message: `Not found: ${req.method} ${path}` },
      id: null,
    });
  } catch (err: any) {
    console.error(`[mcp-http] Unhandled error on ${req.method} ${path}:`, err);
    if (!res.headersSent) {
      return sendJson(res, 500, {
        jsonrpc: "2.0",
        error: { code: -32603, message: err?.message || "Internal error" },
        id: null,
      });
    }
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[mcp-http] Computeback MCP server listening on ${HOST}:${PORT} (transport=streamable_http)`);
});
