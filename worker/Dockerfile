FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
COPY api/package.json ./api/
COPY worker/package.json ./worker/
COPY admin/package.json ./admin/
# Full install — worker runs sync scripts via tsx against api/src
RUN npm install

FROM node:22-alpine AS build
WORKDIR /app
COPY --from=deps /app /app
COPY tsconfig.base.json ./
COPY worker ./worker
WORKDIR /app/worker
RUN npx tsc -p tsconfig.json

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
ARG GIT_SHA=dev
ARG APP_VERSION=0.1.0
ENV GIT_SHA=$GIT_SHA
ENV APP_VERSION=$APP_VERSION
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/package.json ./package.json
COPY --from=deps /app/api/package.json ./api/package.json
COPY --from=deps /app/worker/package.json ./worker/package.json
COPY tsconfig.base.json ./
COPY api ./api
COPY scripts ./scripts
COPY --from=build /app/worker/dist ./worker/dist
WORKDIR /app
CMD ["node", "worker/dist/index.js"]
