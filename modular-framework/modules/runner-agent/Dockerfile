FROM node:18-alpine
WORKDIR /app

COPY package.json ./
RUN npm install --production

COPY . .

ENV NODE_ENV=production
ENV PORT=4010
# Set at runtime:
# ENV RUNNER_TOKEN=
# ENV RUNNER_BASE_DIR=/tmp/runner-agent
# ENV RUNNER_DEFAULT_TIMEOUT_MS=20000
# ENV RUNNER_ALLOW_ENV=

EXPOSE 4010

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://localhost:${PORT}/health || exit 1

CMD ["npm", "start"]
