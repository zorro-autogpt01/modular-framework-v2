FROM node:18-alpine

WORKDIR /app

# Install Chrome for headless browsing if needed
RUN apk add --no-cache \
    chromium \
    nss \
    freetype \
    freetype-dev \
    harfbuzz \
    ca-certificates \
    ttf-freefont

# Install dependencies
COPY server/package.json ./
RUN npm install

# Copy application
COPY server ./server
COPY public ./public

ENV PORT=3008
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser

EXPOSE 3008

CMD ["node", "server/index.js"]