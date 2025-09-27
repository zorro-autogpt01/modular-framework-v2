# syntax=docker/dockerfile:1
FROM node:20-alpine

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3021

# Install dependencies first for better layer caching
COPY package.json ./package.json
RUN npm install --omit=dev

# Copy source files
COPY server.js ./server.js
COPY sshManager.js ./sshManager.js
COPY sshBridge.js ./sshBridge.js

EXPOSE 3021

CMD ["node", "server.js"]
