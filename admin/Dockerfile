FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
COPY api/package.json ./api/
COPY worker/package.json ./worker/
COPY admin/package.json ./admin/
RUN npm install --workspace=@pfm/admin
COPY admin ./admin
WORKDIR /app/admin
RUN npm run build

FROM nginx:1.27-alpine
COPY admin/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/admin/dist /usr/share/nginx/html
EXPOSE 80
