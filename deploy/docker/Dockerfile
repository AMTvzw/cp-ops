FROM node:22-alpine

ARG APP_VERSION=dev
LABEL org.opencontainers.image.title="CP-OPS" \
      org.opencontainers.image.description="Operational coordination platform for events and interventions" \
      org.opencontainers.image.version="${APP_VERSION}" \
      org.opencontainers.image.source="https://github.com/AMTvzw/cp-ops"

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

RUN mkdir -p /app/data /app/uploads

ENV NODE_ENV=production \
    APP_VERSION=${APP_VERSION} \
    PORT=31987 \
    DB_CLIENT=sqlite3 \
    DB_FILENAME=/app/data/cp_ops.sqlite \
    DB_CONNECT_TIMEOUT_MS=15000 \
    DB_POOL_MIN=0 \
    DB_POOL_MAX=10 \
    DB_POOL_CREATE_TIMEOUT_MS=10000 \
    DB_POOL_ACQUIRE_TIMEOUT_MS=15000 \
    DB_POOL_IDLE_TIMEOUT_MS=30000 \
    DB_POOL_REAP_INTERVAL_MS=1000 \
    DB_ACQUIRE_CONNECTION_TIMEOUT_MS=15000 \
    SESSION_IDLE_TIMEOUT_MINUTES=60 \
    UPLOAD_STORAGE=fs

EXPOSE 31987

HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:31987/api/settings').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["npx", "tsx", "server.ts"]
