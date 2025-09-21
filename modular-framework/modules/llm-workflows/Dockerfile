FROM node:18-alpine
WORKDIR /app

COPY package.json ./
RUN npm install --production

COPY . .

ENV NODE_ENV=production
ENV PORT=3006

EXPOSE 3006

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://localhost:$PORT/health || exit 1

CMD ["node", "server/index.js"]

