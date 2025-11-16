# modules/github-hub/Dockerfile
FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl ca-certificates && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app
COPY public ./public

# data dir for encrypted config/token
RUN mkdir -p /data
ENV DATA_DIR=/data
ENV PORT=3005

EXPOSE 3005
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "3005"]
