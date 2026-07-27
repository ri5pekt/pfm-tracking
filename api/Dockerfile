# API image — production runtime
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
COPY api/package.json ./api/
COPY worker/package.json ./worker/
COPY admin/package.json ./admin/
RUN npm install --workspace=@pfm/api

FROM node:22-alpine AS build
WORKDIR /app
COPY --from=deps /app /app
COPY tsconfig.base.json ./
COPY api ./api
WORKDIR /app/api
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
ARG GIT_SHA=dev
ARG APP_VERSION=0.1.0
ENV GIT_SHA=$GIT_SHA
ENV APP_VERSION=$APP_VERSION
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/api/package.json ./api/package.json
COPY --from=build /app/api/dist ./api/dist
COPY api/src/public ./api/dist/public
COPY api/public ./api/public
COPY api/catalog ./api/catalog
COPY api/migrations ./api/migrations
WORKDIR /app/api
EXPOSE 3000
CMD ["node", "dist/index.js"]
