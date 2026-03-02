FROM node:22-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

RUN mkdir -p /app/data /app/uploads

ENV NODE_ENV=production \
    PORT=31987 \
    DB_CLIENT=sqlite3 \
    DB_FILENAME=/app/data/cp_ops.sqlite \
    UPLOAD_STORAGE=fs

EXPOSE 31987

CMD ["npx", "tsx", "server.ts"]
