# framework/Dockerfile
# Purpose: Serve the framework UI (static HTML/CSS/JS) via nginx inside the cluster.
# TLS and reverse-proxying are handled by the separate edge-nginx container.

FROM nginx:alpine

# Install curl for healthcheck
RUN apk add --no-cache curl

# Copy nginx configuration (serves SPA and /health)
COPY nginx.conf /etc/nginx/nginx.conf

# Copy static assets
COPY html /usr/share/nginx/html

# Healthcheck hits the container-local endpoint
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD curl -sf http://localhost/health || exit 1

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
