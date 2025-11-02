# modular-framework/modules/code-slicer-orchestrator/Dockerfile
FROM python:3.11-slim

WORKDIR /app

# Install system dependencies
RUN apt-get update && apt-get install -y \
    git \
    curl \
    wget \
    && rm -rf /var/lib/apt/lists/*

# Copy requirements first (layer caching)
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application code
COPY server/ ./server/
COPY cli/ ./cli/
COPY static/ ./static/

# Create data directory
RUN mkdir -p /app/data/cache /app/data/extractions

# Environment defaults
ENV PORT=3050
ENV DATA_DIR=/app/data
ENV LLM_GATEWAY_URL=http://llm-gateway:3010
ENV PYTHON_UNBUFFERED=1

# Expose port for web UI
EXPOSE 3050

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:${PORT}/health || exit 1

# Run web server by default (can override with CLI)
CMD ["python", "-m", "server.app"]