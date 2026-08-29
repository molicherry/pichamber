# pichamber web — multi-stage build.
# Runtime must be Node >= 22 (pi SDK compatibility). node-pty has no Linux
# prebuilt binary, so the build stage installs a C toolchain to compile it.
#
# pi runtime (extensions + npm plugins) is baked in; models.json (API keys)
# is NOT — it is injected at runtime via a volume mount (see docker-compose.yml).

# ---- build stage ----
FROM node:22-bookworm AS build
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
RUN npm install -g bun

WORKDIR /app
COPY package.json bun.lock tsconfig.base.json ./
COPY packages ./packages
RUN bun install --frozen-lockfile
RUN bun run --filter @pichamber/ui build

# pi runtime: permission/protected-path extensions + npm plugins (lsp, mcp)
COPY pi-extensions ./pi-extensions
RUN mkdir -p /app/.pi-agent/extensions /app/.pi-agent/npm \
    && cp pi-extensions/*.ts /app/.pi-agent/extensions/ \
    && printf '{"name":"pi-extensions","private":true,"dependencies":{"pi-lens":"^3.8.71","pi-mcp-adapter":"^2.21.0"}}\n' > /app/.pi-agent/npm/package.json \
    && cd /app/.pi-agent/npm && npm install --no-audit --no-fund

# ---- runtime stage ----
FROM node:22-bookworm-slim
RUN npm install -g bun

WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/bun.lock ./bun.lock
COPY --from=build /app/.pi-agent ./.pi-agent

ENV PORT=8787
ENV UI_DIST=/app/packages/ui/dist
ENV PI_CODING_AGENT_DIR=/app/.pi-agent
EXPOSE 8787

CMD ["bun", "run", "--filter", "@pichamber/web", "dev"]
