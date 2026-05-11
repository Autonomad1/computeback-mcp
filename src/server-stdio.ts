#!/usr/bin/env node
/**
 * Computeback MCP server — stdio entry-point.
 *
 * This is what `npx computeback-mcp-server` invokes. Tools call into the
 * backend at `COMPUTEBACK_API_URL`. CB Hire tools sign requests with the
 * agent's HMAC secret loaded from env at process start.
 *
 * For the streamable-http variant (hosted at mcp.computeback.com) see
 * `server-http.ts`. Both share the same tool surface via `server-core.ts`.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildServer, makeStdioAuthContext } from "./server-core.js";

async function main() {
  const authCtx = makeStdioAuthContext();
  const server = buildServer(authCtx);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Computeback MCP Server running on stdio");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
