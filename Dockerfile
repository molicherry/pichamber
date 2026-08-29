# pichamber web — multi-stage build.
# Runtime must be Node >= 22 (pi SDK compatibility). node-pty has no Linux
# prebuilt binary, so the build stage installs a C toolchain to compile it.

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

# ---- runtime stage ----
FROM node:22-bookworm-slim
RUN npm install -g bun

WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/bun.lock ./bun.lock

ENV PORT=8787
ENV UI_DIST=/app/packages/ui/dist
EXPOSE 8787

CMD ["bun", "run", "--filter", "@pichamber/web", "dev"]
