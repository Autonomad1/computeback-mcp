# Computeback MCP server — dual-transport image.
#
# Default CMD runs the stdio binary, which is what Glama's automated
# scanner (and any "docker run | tools/list" probe) expects. Railway's
# deploy.startCommand in railway.json overrides this to run the
# Streamable-HTTP server at https://mcp.computeback.com/mcp — same 28
# tools, different transport.
#
# Build context: this Dockerfile assumes the build is run from the
# `mcp-server/` directory (the Railway service root).
#
# Build & runtime in one stage — the bundle is small enough that two
# stages add complexity for ~zero size win. node_modules is the bulk.

FROM node:20-alpine
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8080
ENV HOST=0.0.0.0

# Install deps first (cache layer) — include dev deps for the build step
# (typescript is in devDependencies).
COPY package.json package-lock.json* ./
RUN npm install --include=dev && npm cache clean --force

# Source + build
COPY tsconfig.json ./
COPY src/ ./src/
RUN ./node_modules/.bin/tsc --project tsconfig.json && \
    chmod +x dist/server-http.js dist/server-stdio.js dist/server.js

# Drop dev deps to slim the runtime image after build.
RUN npm prune --omit=dev

EXPOSE 8080
# Healthcheck only runs when Railway overrides CMD to the HTTP server.
# For stdio scans (Glama), there's no port to probe — the healthcheck
# will fail silently in that mode, which is fine for short-lived scans.
HEALTHCHECK --interval=30s --timeout=3s --start-period=15s --retries=3 \
  CMD wget -qO- http://localhost:${PORT}/health || exit 1

# Default: stdio. Railway overrides via railway.json -> server-http.js.
CMD ["node", "dist/server-stdio.js"]
