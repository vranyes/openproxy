# syntax=docker/dockerfile:1
FROM oven/bun:1.4.3-alpine AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM oven/bun:1.4.3-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production PORT=8080
COPY --from=deps /app/node_modules ./node_modules
COPY package.json bun.lock ./
COPY src ./src
COPY examples ./examples
EXPOSE 8080
USER bun
ENTRYPOINT ["bun", "src/index.ts"]
CMD ["examples/gateway.yaml"]
