FROM node:18-alpine

# Install git and other dependencies
RUN apk add --no-cache git openssh-client bash

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install --only=production

# Copy application code
COPY . .

# Create necessary directories
RUN mkdir -p /workspace/repos /workspace/history /workspace/staging /workspace/locks

EXPOSE 3006 3007

CMD ["node", "src/server.js"]
