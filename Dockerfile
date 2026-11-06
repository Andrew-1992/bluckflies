# syntax=docker/dockerfile:1

# ---- dependencies (all, including the Prisma CLI) --------------------------
FROM node:22-alpine AS deps
# The Prisma schema engine (used only by the migrate target) links OpenSSL.
RUN apk add --no-cache openssl
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
# Download the schema engine into the image now, not at container start.
RUN npx prisma --version

# ---- build ------------------------------------------------------------------
FROM deps AS build
COPY tsconfig.json tsconfig.build.json prisma.config.ts ./
COPY prisma ./prisma
COPY src ./src
RUN npx prisma generate && npx tsc -p tsconfig.build.json

# ---- migrate: one-shot job that applies migrations, then exits ---------------
# Runs with the schema-owner role (MIGRATION_DATABASE_URL). Never serves traffic.
FROM deps AS migrate
COPY prisma.config.ts ./
COPY prisma ./prisma
USER node
CMD ["npx", "prisma", "migrate", "deploy"]

# ---- runtime: the app -------------------------------------------------------
# No migration engine or schema-changing credentials: the app role can only
# read and write rows (see deploy/postgres/init-roles.sh).
FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node public ./public
COPY --chown=node:node legal ./legal
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 CMD wget -qO- http://127.0.0.1:3000/readyz || exit 1
CMD ["node", "dist/server.js"]
