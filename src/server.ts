#!/usr/bin/env node
/**
 * Backwards-compatible re-export of the stdio entry-point.
 *
 * Historically `dist/server.js` was the published bin and the only
 * transport supported was stdio. We've since split the implementation
 * into `server-core.ts` (the McpServer + 28 tools) and per-transport
 * entry-points (`server-stdio.ts`, `server-http.ts`). This file remains
 * so existing installs that still resolve `dist/server.js` (via the
 * `computeback-mcp` / `computeback-mcp-server` bin entries pre-1.1.0,
 * or via direct path imports) keep working unchanged.
 *
 * New consumers should run `node dist/server-stdio.js` directly or use
 * the `computeback-mcp` bin which now points at server-stdio.
 */
import "./server-stdio.js";
