FROM node:20-alpine AS base
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm install --omit=dev

COPY . .
EXPOSE 3040
ENV PORT=3040

CMD ["node", "server.js"]
