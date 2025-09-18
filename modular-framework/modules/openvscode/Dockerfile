FROM gitpod/openvscode-server:latest

# --- System setup -------------------------------------------------------------
USER root

# Install additional tools
RUN apt-get update && apt-get install -y \
    curl \
    git \
    nodejs \
    npm \
    python3 \
    python3-pip \
    docker.io \
    jq \
    ca-certificates \
    wget \
 && rm -rf /var/lib/apt/lists/*

# Create workspace directory (owned by the openvscode-server user)
RUN mkdir -p /home/workspace && \
    chown -R openvscode-server:openvscode-server /home/workspace

# --- App setup ----------------------------------------------------------------
# Work in the openvscode home so paths are predictable
WORKDIR /home/openvscode-server

# Install API server deps (use caching: copy package manifest first)
COPY --chown=openvscode-server:openvscode-server server/package*.json ./server/
# If there's no package-lock.json, npm ci will fail; fallback to npm install is fine.
RUN cd server && npm ci || npm install

# Copy API server source and optional config
COPY --chown=openvscode-server:openvscode-server server ./server
COPY --chown=openvscode-server:openvscode-server config ./config

# Copy the start script
COPY --chown=openvscode-server:openvscode-server start.sh /home/openvscode-server/start.sh
RUN chmod +x /home/openvscode-server/start.sh

# --- Runtime env --------------------------------------------------------------
USER openvscode-server

ENV WORKSPACE_DIR=/home/workspace
ENV PORT=3006
ENV API_PORT=3007
ENV NODE_ENV=production

# Expose ports
EXPOSE 3006 3007

# Start both the API and OpenVSCode Server
CMD ["/home/openvscode-server/start.sh"]
