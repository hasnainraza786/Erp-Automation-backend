# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim AS base
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
RUN corepack enable
WORKDIR /app

FROM base AS build
COPY package.json yarn.lock .yarnrc.yml ./
RUN yarn install --immutable
COPY prisma ./prisma
COPY tsconfig.json nest-cli.json ./
COPY src ./src
RUN yarn build

FROM base AS runtime
ENV NODE_ENV=production PORT=4000
# Single-package repo: reuse the build install (includes prisma CLI for migrate deploy).
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/package.json ./
USER node
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=45s CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# Applies pending migrations and the idempotent base seed, then starts the API.
CMD ["sh", "-c", "node_modules/.bin/prisma migrate deploy && node dist/cli/seed.js && node dist/main.js"]
