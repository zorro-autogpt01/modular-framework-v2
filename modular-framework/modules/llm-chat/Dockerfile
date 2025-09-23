FROM node:18-alpine
WORKDIR /app

# Install deps
COPY package.json ./
RUN npm install --production

# Copy source
COPY . .
COPY ./splunk-logger /splunk-logger


ENV NODE_ENV=production
ENV PORT=3004

EXPOSE 3004

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://localhost:$PORT/health || exit 1

CMD ["node", "server/index.js"]
