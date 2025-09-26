FROM node:18-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --production
COPY . .
ENV PORT=3015
EXPOSE 3015
CMD ["node", "server/index.js"]
