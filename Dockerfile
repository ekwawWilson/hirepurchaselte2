# hp-lite container image for the eyo fleet.
#
# Deliberately plain: one build stage, one runtime stage, full node_modules at
# runtime rather than Next's standalone output. Standalone is smaller but drops
# files this app resolves at runtime; the size is not worth the debugging.
#
# Migrations are NOT run here. They run in CI before the image is published, so
# a bad migration means the image never ships and the box keeps serving the old
# code against the old schema — schema ahead of code is the only ordering a
# rolling deploy tolerates.
FROM node:22-bookworm-slim AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

# openssl in the BUILDER too, not just the runtime stage. `prisma generate`
# picks its query-engine target by sniffing the platform, and with no openssl
# present it guesses openssl-1.1.x. The engine is then copied into a runtime that
# has 3.0.x and every query fails with "could not locate the Query Engine".
#
# That failure is invisible to the container healthcheck: /api/health returns
# static JSON and never touches the database, so the container reports HEALTHY
# while nothing that reads data works. Same shape as the owna-api outage.
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# Generate before build: the client is imported by server components at build time.
RUN npx prisma generate && npm run build

FROM node:22-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000

# openssl: Prisma's query engine links against it. Absent, the client fails at
# first query with a message about libssl that reads as a corrupt image.
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl ca-certificates wget \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/public ./public
COPY --from=builder /app/prisma ./prisma
# The TypeScript sources, for the one script that runs against a live database:
# prisma/runSyncRbac.ts imports the permission catalogue from src/lib/constants/rbac.
# CI used to run it from a checkout; a container deploy has only what is copied here.
COPY --from=builder /app/src ./src
COPY --from=builder /app/tsconfig.json ./tsconfig.json
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/next.config.ts ./next.config.ts

RUN chown -R node:node /app
USER node

HEALTHCHECK --interval=15s --timeout=5s --start-period=40s --retries=5 \
    CMD wget -qO- http://127.0.0.1:${PORT}/api/health || exit 1

EXPOSE 3000
CMD ["npm", "run", "start"]
