# Multi-stage Dockerfile for @pairprep/server

# Stage 1: Build
FROM node:22-alpine AS builder

WORKDIR /app

# Copy root manifests and lockfiles for dependency caching
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json ./packages/shared/
COPY apps/server/package.json ./apps/server/

# Install all workspace dependencies
RUN npm ci

# Copy source files
COPY packages/shared ./packages/shared
COPY apps/server ./apps/server

# Build shared package then server
RUN npm run --workspace=packages/shared build && \
    npm run --workspace=apps/server build

# Remove development dependencies for a lean production image
RUN npm prune --omit=dev

# Stage 2: Production Runner
FROM node:22-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
# Cap Node heap to 384 MB to prevent OOM on 1 GB RAM Azure B1s VM
ENV NODE_OPTIONS="--max-old-space-size=384"
ENV PORT=3000

# Copy node_modules and built artifacts
COPY --from=builder /app/package.json /app/package-lock.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages/shared/package.json ./packages/shared/
COPY --from=builder /app/packages/shared/dist ./packages/shared/dist
COPY --from=builder /app/apps/server/package.json ./apps/server/
COPY --from=builder /app/apps/server/dist ./apps/server/dist

# Security hardening: run as unprivileged non-root user
USER node

EXPOSE 3000

CMD ["node", "apps/server/dist/index.js"]
