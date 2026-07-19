# Multi-stage: build with dev deps, ship runtime-only. Used by the compose
# "staging" profile and CI; local no-Docker dev runs `npm run start:dev`.
FROM node:20-alpine AS build
WORKDIR /repo
COPY package.json package-lock.json* ./
COPY packages/shared/package.json packages/shared/
COPY apps/gateway/package.json apps/gateway/
RUN npm install
COPY packages/shared packages/shared
COPY apps/gateway apps/gateway
COPY infra/postgres/schema.sql infra/postgres/schema.sql
RUN npm run build --workspace apps/gateway

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /repo/apps/gateway/dist ./dist
COPY --from=build /repo/node_modules ./node_modules
COPY --from=build /repo/infra ./infra
EXPOSE 3000
# SIGTERM → onModuleDestroy closes sockets with 1012 (graceful drain).
CMD ["node", "dist/apps/gateway/src/main.js"]
