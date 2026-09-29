# syntax=docker/dockerfile:1
# One Dockerfile, two deployables: `--target backend` and `--target probe`.

FROM node:22-bookworm-slim AS build
RUN apt-get update -y && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY prisma ./prisma
COPY src ./src
RUN npx prisma generate && npx tsc -p tsconfig.json

# ---------------------------------------------------------------- backend
FROM node:22-bookworm-slim AS backend
RUN apt-get update -y && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY prisma ./prisma
RUN npx prisma generate
COPY --from=build /app/dist ./dist
COPY probe/install.sh ./probe/install.sh
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=40s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/backend/main.js"]

# ---------------------------------------------------------------- probe (no node_modules at all)
FROM node:22-alpine AS probe
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/dist/shared ./dist/shared
COPY --from=build /app/dist/probe ./dist/probe
USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=45s --retries=3 \
  CMD test -n "$(find /tmp/probe-ok -mmin -2 2>/dev/null)" || exit 1
CMD ["node", "dist/probe/main.js"]
