# Runs TypeScript directly with Bun; there is no build step.
# Build from the repository root, because the server uses the @comma/shared workspace package:
#   docker build -f apps/server/Dockerfile -t comma-server .
FROM oven/bun:1.4-alpine AS deps
WORKDIR /app
COPY package.json bun.lock ./
COPY apps/server/package.json apps/server/bunfig.toml apps/server/
COPY packages/shared/package.json packages/shared/
RUN bun install --frozen-lockfile --production --filter @comma/server

FROM oven/bun:1.4-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/server/node_modules ./apps/server/node_modules
COPY --from=deps /app/packages/shared/node_modules ./packages/shared/node_modules
COPY package.json ./
COPY packages/shared ./packages/shared
COPY apps/server/package.json apps/server/bunfig.toml apps/server/tsconfig.json apps/server/drizzle.config.ts apps/server/
COPY apps/server/drizzle ./apps/server/drizzle
COPY apps/server/src ./apps/server/src
WORKDIR /app/apps/server
USER bun
EXPOSE 8787
# Migrations: docker run <image> bun src/migrate.ts (docker-compose.yml runs them as the `migrate` service)
CMD ["bun", "src/main.ts"]
