# ── Stage 1: build ──────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

# Copy root workspace manifest + lockfile
COPY package.json package-lock.json* ./

# Copy each package's manifest so npm workspaces can link them
COPY packages/shared/package.json ./packages/shared/package.json
COPY packages/server/package.json ./packages/server/package.json
COPY packages/client/package.json ./packages/client/package.json

# Install all workspace deps
RUN npm install --legacy-peer-deps

# Copy source
COPY packages/shared ./packages/shared
COPY packages/server ./packages/server

# Build shared first, then server
RUN npm run build --workspace=packages/shared
RUN npm run build --workspace=packages/server

# ── Stage 2: production image ────────────────────────────────────────────────
FROM node:20-alpine AS runner

WORKDIR /app

# Copy root workspace manifest so npm knows about workspaces
COPY package.json package-lock.json* ./
COPY packages/shared/package.json ./packages/shared/package.json
COPY packages/server/package.json  ./packages/server/package.json
COPY packages/client/package.json  ./packages/client/package.json

# Install production deps only
RUN npm install --omit=dev --legacy-peer-deps

# Copy built output from builder
COPY --from=builder /app/packages/shared/dist ./packages/shared/dist
COPY --from=builder /app/packages/server/dist  ./packages/server/dist

EXPOSE 5000

ENV NODE_ENV=production
ENV PORT=5000
ENV HOST=0.0.0.0

CMD ["node", "packages/server/dist/index.js"]
