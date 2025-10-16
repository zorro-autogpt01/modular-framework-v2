FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

# ---- system deps (needed to build pygraphviz, run diagrams) ----
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    graphviz \
    graphviz-dev \
    pkg-config \
    git curl \
    doxygen \
    nodejs npm \
 && rm -rf /var/lib/apt/lists/*

# Optional: help setuptools find Graphviz if needed
# ENV CFLAGS="$(pkg-config --cflags libgvc)" \
#     LDFLAGS="$(pkg-config --libs libgvc)"

COPY requirements.txt ./
RUN pip install --no-cache-dir -U pip setuptools wheel \
 && pip install --no-cache-dir -r requirements.txt

COPY . .
EXPOSE 8000

CMD ["uvicorn", "src.codecontext.main:app", "--host", "0.0.0.0", "--port", "8000"]