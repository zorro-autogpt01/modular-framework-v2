FROM node:18-alpine
WORKDIR /app

RUN apk add --no-cache python3 make g++ bash curl

COPY package.json ./
RUN npm install --production

COPY . .

ENV NODE_ENV=production
ENV PORT=4015
ENV INTERNAL_API_TOKEN=supersecret
ENV RUNNER_REG_TOKEN=supersecret
ENV DB_URL=sqlite:///app/data/runner.db
ENV HEALTH_INTERVAL_SEC=15
ENV EXEC_MAX_TIMEOUT_MS=300000
ENV LOG_TO_CONSOLE=false

EXPOSE 4015

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://localhost:$PORT/health || exit 1

CMD ["node", "server/index.js"]
