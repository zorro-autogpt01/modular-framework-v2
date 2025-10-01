#!/usr/bin/env bash
set -euo pipefail

# Install runner-agent to host with systemd service
# Usage (as root):
#   AGENT_NAME=lab \
#   AGENT_TOKEN=supersecret \
#   REGISTER_URL=http://localhost:3005/api/runners/register \
#   REGISTER_TOKEN=supersecret \
#   AGENT_URL=http://127.0.0.1:4010 \
#   DEFAULT_CWD=/home/youruser/modules/temp \
#   ./install.sh

if [[ $EUID -ne 0 ]]; then
  echo "Please run as root (sudo)"; exit 1
fi

# Resolve paths
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST_DIR="/opt/runner-agent"
ENV_FILE="/etc/runner-agent.env"
SERVICE_FILE="/etc/systemd/system/runner-agent.service"

# Ensure Node is installed
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is required. Please install Node.js 18+."; exit 2
fi

# Defaults
: "${PORT:=4010}"
: "${AGENT_NAME:=runner}"
: "${AGENT_TOKEN:=}"
: "${REGISTER_URL:=}"
: "${REGISTER_TOKEN:=}"
: "${AGENT_URL:=}"
: "${DEFAULT_CWD:=${PWD}}"

mkdir -p "$DEST_DIR"
cp -f "$SCRIPT_DIR/agent.js" "$DEST_DIR/agent.js"
cp -f "$SCRIPT_DIR/package.json" "$DEST_DIR/package.json"

# Install dependencies (production)
pushd "$DEST_DIR" >/dev/null
npm install --omit=dev
popd >/dev/null

# Create env file
cat > "$ENV_FILE" <<EOF
# runner-agent environment
PORT=${PORT}
AGENT_NAME=${AGENT_NAME}
AGENT_TOKEN=${AGENT_TOKEN}
REGISTER_URL=${REGISTER_URL}
REGISTER_TOKEN=${REGISTER_TOKEN}
AGENT_URL=${AGENT_URL}
DEFAULT_CWD=${DEFAULT_CWD}
NODE_ENV=production
EOF
chmod 600 "$ENV_FILE"

# Create systemd service
cat > "$SERVICE_FILE" <<'EOF'
[Unit]
Description=Runner Agent (LLM Workflows)
After=network.target

[Service]
Type=simple
EnvironmentFile=/etc/runner-agent.env
WorkingDirectory=/opt/runner-agent
ExecStart=/usr/bin/env node /opt/runner-agent/agent.js
Restart=on-failure
RestartSec=2
User=root
# You can change the user above to a dedicated one and grant permissions to DEFAULT_CWD.

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable runner-agent
systemctl restart runner-agent

echo "runner-agent installed and started."
echo "Service: systemctl status runner-agent"
echo "Health:  curl -s http://localhost:${PORT}/health"