FROM node:26-alpine AS builder
WORKDIR /app
COPY package*.json .npmrc ./
ARG GITHUB_TOKEN
RUN echo "@wyre-ai:registry=https://npm.pkg.github.com" > .npmrc && \
    echo "//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}" >> .npmrc && \
    npm install && \
    rm -f .npmrc
COPY . .
RUN npm run build

FROM node:26-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 mcp
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./
USER mcp
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:8080/health || exit 1
ENV MCP_TRANSPORT=http
ENV MCP_HTTP_PORT=8080
# 0.0.0.0 is safe inside the container only because startup refuses to
# listen without a real CONDUIT_S2S_SECRET. MCP_ALLOW_INSECURE_DEV=1
# ignores this host and binds 127.0.0.1 only. AUTH_MODE=gateway never
# falls back to image env credentials.
ENV MCP_HTTP_HOST=0.0.0.0
ENV AUTH_MODE=gateway
LABEL io.modelcontextprotocol.server.name="io.github.WYRE-AI/connectwise-automate-mcp"
CMD ["node", "dist/index.js"]
