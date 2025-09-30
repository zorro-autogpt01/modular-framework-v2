# modules/llm-documentor/Dockerfile
FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

# Install system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    ca-certificates \
    git \
    && rm -rf /var/lib/apt/lists/*

# Copy requirements and install Python dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Create necessary directories
RUN mkdir -p /app/public /app/templates /app/logs /data/cache /data/output

# Copy application code
COPY . .

# Set environment variables
ENV DATA_DIR=/data
ENV PORT=3030
ENV GITHUB_HUB_URL=http://github-hub-module:3005/api
ENV LLM_GATEWAY_URL=http://llm-gateway:3010/api

# Create non-root user
RUN useradd -m -u 1000 docgen && chown -R docgen:docgen /app /data
USER docgen

EXPOSE 3030

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:3030/api/health || exit 1

CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "3030"]