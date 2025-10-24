# code-slicer-service/Dockerfile
FROM node:18-alpine

# Install Python and dependencies
RUN apk add --no-cache \
    python3 \
    py3-pip \
    git \
    graphviz

# Install Python packages
RUN pip3 install --break-system-packages \
    --no-cache-dir \
    pyyaml

# Create app directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install Node dependencies
RUN npm install --only=production

# Copy application
COPY . .

# Copy the corrected code slicer script
COPY scripts/api_code_slicer.py /app/scripts/

# Make script executable
RUN chmod +x /app/scripts/api_code_slicer.py

# Create data directories
RUN mkdir -p /data /cache /data/repos /data/slices

# Expose port
EXPOSE 3012

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3012/health', (r) => { process.exit(r.statusCode === 200 ? 0 : 1); })"

# Start server
CMD ["node", "server.js"]