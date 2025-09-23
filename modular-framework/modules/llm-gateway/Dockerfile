FROM node:18-alpine
WORKDIR /app

COPY package.json ./
RUN npm install --production

COPY . .
COPY ./splunk-logger /splunk-logger

ENV NODE_ENV=production
ENV PORT=3010

EXPOSE 3010

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://localhost:$PORT/health || exit 1

CMD ["node", "server/index.js"]

