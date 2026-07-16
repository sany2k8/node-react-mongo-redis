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

# Stamped into the image so a Kubernetes rolling update is observable at
# GET /api/  ->  docker build --build-arg APP_VERSION=v2 -t ...:v2 .
ARG APP_VERSION=dev

ENV NODE_ENV=production \
    PORT=3000 \
    APP_VERSION=${APP_VERSION} \
    MONGO_HOST=mongo \
    MONGO_PORT=27017 \
    REDIS_HOST=redis \
    REDIS_PORT=6379

EXPOSE 3000

CMD ["node", "src/index.js"]
