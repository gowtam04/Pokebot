# syntax=docker/dockerfile:1

# ---- deps: full install (incl. devDeps) for the build ----
# Do NOT set NODE_ENV=production here — `npm ci` would skip the devDependencies
# (typescript, etc.) that `next build` needs.
FROM node:20-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# ---- build: compile Next in standalone mode ----
FROM node:20-bookworm-slim AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# `next build` runs with NODE_ENV=production internally. If any built module
# evaluates src/env.ts, Zod requires a non-empty ANTHROPIC_API_KEY AND, because
# NODE_ENV=production during the build, a non-default AUTH_SECRET (prod guard).
# Supply DUMMY, build-only values so the build can never crash. These never reach
# the final image; the real values come from Fly secrets at runtime.
ENV ANTHROPIC_API_KEY="dummy-build-key-not-used-at-runtime"
ENV AUTH_SECRET="dummy-build-secret-not-the-dev-default"
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# ---- runner: minimal standalone runtime ----
FROM node:20-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# Non-root runtime user.
RUN groupadd --system --gid 1001 nodejs \
 && useradd --system --uid 1001 --gid nodejs nextjs

# Standalone server + its pruned node_modules, plus the static assets.
# (No public/ dir exists in this repo — do NOT add `COPY ... public`.)
COPY --from=build --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=build --chown=nextjs:nodejs /app/.next/static ./.next/static

# Migration assets for the Fly release_command (tiny). drizzle-orm's migrator and
# pg are already traced into ./node_modules via src/data/db.ts; we only add the
# committed SQL files and a plain-ESM runner that does NOT import src/env.ts.
COPY --from=build --chown=nextjs:nodejs /app/drizzle ./drizzle
COPY --from=build --chown=nextjs:nodejs /app/migrate.mjs ./migrate.mjs

USER nextjs
EXPOSE 3000

CMD ["node", "server.js"]
