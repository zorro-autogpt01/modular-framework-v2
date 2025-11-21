# File Watcher Container Dockerfile

FROM node:18-alpine

# Install git for source detection
RUN apk add --no-cache git

# Create app directory
WORKDIR /app

# Copy package files
COPY package.json ./

# Install dependencies
RUN npm install --production

# Copy application files
COPY server.js ./
COPY services/ ./services/
COPY routes/ ./routes/
COPY database/ ./database/
COPY public/ ./public/

# Create data directory for SQLite database
RUN mkdir -p /app/data

# Expose port
EXPOSE 3042

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3042/health', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})"

# Start server
CMD ["node", "server.js"]