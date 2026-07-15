# syntax=docker/dockerfile:1

# ---- Stage 1: build the React (Vite) frontend with pnpm --------------------
FROM node:22-slim AS frontend-build
RUN corepack enable && corepack prepare pnpm@9.7.0 --activate
WORKDIR /frontend
COPY frontend/package.json ./
RUN pnpm install --no-frozen-lockfile
COPY frontend/ ./
RUN pnpm build

# ---- Stage 2: backend runtime ----------------------------------------------
FROM node:22-slim AS backend
RUN corepack enable && corepack prepare pnpm@9.7.0 --activate
WORKDIR /app
COPY backend/package.json ./
RUN pnpm install --no-frozen-lockfile --prod
COPY backend/src ./src

# Bring in the built frontend assets so Express can serve them statically.
COPY --from=frontend-build /frontend/dist ./public

ENV NODE_ENV=production \
    PORT=3000 \
    MONGO_HOST=mongo \
    MONGO_PORT=27017 \
    REDIS_HOST=redis \
    REDIS_PORT=6379

EXPOSE 3000

CMD ["node", "src/index.js"]
