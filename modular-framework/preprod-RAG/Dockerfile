# Multi-stage build for production efficiency
FROM python:3.11-slim as builder

WORKDIR /app
COPY requirements.txt .
RUN pip install --user --no-cache-dir -r requirements.txt

FROM python:3.11-slim

# Security: create non-root user and install git
RUN useradd --create-home --shell /bin/bash app \
    && apt-get update \
    && apt-get install -y --no-install-recommends \
        curl \
        git \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /home/app

# Copy dependencies and application code
COPY --from=builder /root/.local /home/app/.local
COPY --chown=app:app . .

USER app

# Add Python packages to PATH
ENV PATH=/home/app/.local/bin:$PATH

# Health check
HEALTHCHECK --interval=30s --timeout=30s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:8000/health || exit 1

EXPOSE 8000

CMD ["python", "rag_system.py"]