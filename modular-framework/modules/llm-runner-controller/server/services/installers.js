// server/services/installers.js
function dockerScript(req, res) {
  const REG_TOKEN_DEFAULT = process.env.RUNNER_REG_TOKEN || '';
  const server = (req.query.server || process.env.PUBLIC_EDGE_BASE || 'http://localhost:8080').replace(/\/+$/, '');
  res.type('text/x-shellscript');
  res.send(`#!/usr/bin/env bash
set -euo pipefail

# Usage:
#   curl -fsSL "${server}/install/runner.sh" | bash -s -- --name myrunner --server ${server} \\
#     --runner-url http://localhost:4010 --port 4010 \\
#     --image runner-agent:ubuntu-24.04 \\
#     --workspace "\${HOME}/projects" \\
#     --reg-token "${REG_TOKEN_DEFAULT}" \\
#     --insecure   # only if your edge uses a dev/self-signed cert

RUNNER_NAME=""
SERVER_BASE="${server}"
RUNNER_URL=""
RUNNER_PORT="4010"
RUNNER_TOKEN=""
BASE_DIR="/tmp/runner-agent"
ALLOW_ENV=""
RUNNER_IMAGE="runner-agent:ubuntu-24.04"
WORKSPACE_DIR="\${HOME}/projects"
DOCKERFILE_DIR=""
REG_TOKEN="${REG_TOKEN_DEFAULT}"
INSECURE="\${INSECURE:-0}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --name) RUNNER_NAME="$2"; shift 2;;
    --server) SERVER_BASE="$2"; shift 2;;
    --runner-url) RUNNER_URL="$2"; shift 2;;
    --port) RUNNER_PORT="$2"; shift 2;;
    --token) RUNNER_TOKEN="$2"; shift 2;;
    --base-dir) BASE_DIR="$2"; shift 2;;
    --allow-env) ALLOW_ENV="$2"; shift 2;;
    --image) RUNNER_IMAGE="$2"; shift 2;;
    --workspace) WORKSPACE_DIR="$2"; shift 2;;
    --dockerfile-dir) DOCKERFILE_DIR="$2"; shift 2;;
    --reg-token) REG_TOKEN="$2"; shift 2;;
    --insecure) INSECURE="1"; shift 1;;
    *) echo "Unknown arg: $1"; exit 1;;
  esac
done

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker is required on the target machine." >&2
  exit 1
fi

if [[ -z "\${RUNNER_NAME}" ]]; then
  RUNNER_NAME="agent-$(hostname)-$(date +%s)"
fi
if [[ -z "\${RUNNER_TOKEN}" ]]; then
  RUNNER_TOKEN="$(tr -dc A-Za-z0-9 </dev/urandom | head -c 24)"
fi
if [[ -z "\${SERVER_BASE}" ]]; then
  echo "Missing --server (e.g., http://localhost:8080 or https://host:8443)" >&2
  exit 1
fi
if [[ -z "\${RUNNER_URL}" ]]; then
  RUNNER_URL="http://localhost:\${RUNNER_PORT}"
fi

mkdir -p "\${BASE_DIR}" "\${WORKSPACE_DIR}"

if ! docker image inspect "\${RUNNER_IMAGE}" >/dev/null 2>&1; then
  BUILD_DIR=""
  if [[ -n "\${DOCKERFILE_DIR}" && -f "\${DOCKERFILE_DIR}/Dockerfile" ]]; then
    BUILD_DIR="\${DOCKERFILE_DIR}"
    echo ">>> Local image '\${RUNNER_IMAGE}' not found. Building from \${BUILD_DIR} ..."
  else
    BUILD_DIR="\${BASE_DIR}/_autobuild"
    echo ">>> Local image '\${RUNNER_IMAGE}' not found. Auto-generating minimal image in \${BUILD_DIR} ..."
    mkdir -p "\${BUILD_DIR}"
    cat > "\${BUILD_DIR}/Dockerfile" <<'EOF_DOCKERFILE'
FROM ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      ca-certificates curl gnupg git bash make python3 python3-pip jq tini && \
    install -m 0755 -d /etc/apt/keyrings && \
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg && \
    chmod a+r /etc/apt/keyrings/docker.gpg && \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu \
      $(. /etc/os-release && echo $VERSION_CODENAME) stable" > /etc/apt/sources.list.d/docker.list && \
    apt-get update && \
    apt-get install -y --no-install-recommends docker-ce-cli docker-compose-plugin && \
    apt-get clean && rm -rf /var/lib/apt/lists/*
WORKDIR /workspace
COPY health_server.py /usr/local/bin/health_server.py
EXPOSE 4010
ENTRYPOINT ["/usr/bin/tini","--"]
CMD ["python3","/usr/local/bin/health_server.py"]
EOF_DOCKERFILE

    cat > "\${BUILD_DIR}/health_server.py" <<'EOF_HEALTH'
from http.server import BaseHTTPRequestHandler, HTTPServer
import json
class H(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/health":
            self.send_response(200)
            self.send_header("Content-Type","application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"ok": True}).encode())
        else:
            self.send_response(200)
            self.send_header("Content-Type","text/plain")
            self.end_headers()
            self.wfile.write(b"runner-base alive\\n")
    def log_message(self, format, *args): pass
HTTPServer(("0.0.0.0", 4010), H).serve_forever()
EOF_HEALTH
  fi

  ARCH=\$(uname -m)
  case "\${ARCH}" in
    aarch64|arm64) PLATFORM="linux/arm64" ;;
    x86_64|amd64) PLATFORM="linux/amd64" ;;
    *) PLATFORM="" ;;
  esac

  if docker buildx version >/dev/null 2>&1; then
    if [[ -n "\${PLATFORM}" ]]; then
      docker buildx build --platform "\${PLATFORM}" -t "\${RUNNER_IMAGE}" "\${BUILD_DIR}" --load
    else
      docker buildx build -t "\${RUNNER_IMAGE}" "\${BUILD_DIR}" --load
    fi
  else
    docker build -t "\${RUNNER_IMAGE}" "\${BUILD_DIR}"
  fi
fi

echo ">>> Starting runner: \${RUNNER_NAME} on port \${RUNNER_PORT}"
if docker ps -a --format '{{.Names}}' | grep -q "^runner-agent-\${RUNNER_NAME}\$"; then
  docker rm -f "runner-agent-\${RUNNER_NAME}" >/dev/null 2>&1 || true
fi

docker run -d --name "runner-agent-\${RUNNER_NAME}" --restart unless-stopped \\
  -p "\${RUNNER_PORT}:4010" \\
  -e RUNNER_TOKEN="\${RUNNER_TOKEN}" \\
  -e RUNNER_BASE_DIR="\${BASE_DIR}" \\
  -e RUNNER_DEFAULT_TIMEOUT_MS="30000" \\
  -e RUNNER_ALLOW_ENV="\${ALLOW_ENV}" \\
  -v "\${BASE_DIR}:\${BASE_DIR}" \\
  -v /var/run/docker.sock:/var/run/docker.sock \\
  -v "\${WORKSPACE_DIR}:/workspace" \\
  "\${RUNNER_IMAGE}"

echo ">>> Waiting for health..."
for i in $(seq 1 30); do
  if curl -fsS -H "Authorization: Bearer \${RUNNER_TOKEN}" "\${RUNNER_URL}/health" >/dev/null 2>&1; then
    echo "Runner healthy."
    break
  fi
  sleep 1
  if [[ "$i" == "30" ]]; then
    echo "Runner did not become healthy in time." >&2
    exit 1
  fi
done

echo ">>> Registering runner..."
set +e
CURL_FLAGS="-fsSL -L"
if [[ "\${INSECURE}" == "1" ]]; then CURL_FLAGS="\${CURL_FLAGS} -k"; fi

register_runner() {
  local base="$1"
  local path="$2"
  local url="\${base%/}\${path}"
  echo ">>> Trying: \${url}"
  local http
  http=$(curl \${CURL_FLAGS} -o /tmp/runner_reg.out -w "%{http_code}" \\
    -X POST \\
    -H "Authorization: Bearer \${REG_TOKEN}" \\
    -H "Content-Type: application/json" \\
    -d '{
      "name": "'"'\${RUNNER_NAME}'"'",
      "url": "'"'\${RUNNER_URL}'"'",
      "token": "'"'\${RUNNER_TOKEN}'"'",
      "default_cwd": "'"'\${BASE_DIR}'"'"
    }' "\${url}" || echo "000")

  if [[ "\$http" =~ ^2 ]]; then
    echo ">>> Registered OK at \${url}"
    rm -f /tmp/runner_reg.out
    return 0
  fi

  echo ">>> Registration failed (HTTP \$http) at \${url}"
  head -c 300 /tmp/runner_reg.out 2>/dev/null | sed 's/.*/>>> Body: &/' || true
  rm -f /tmp/runner_reg.out
  return 1
}

BASES=("\${SERVER_BASE%/}")
if [[ "\${SERVER_BASE}" == http://* ]]; then
  hostport="\${SERVER_BASE#http://}"
  host="\${hostport%%:*}"
  BASES+=("https://\${host}:8443")
fi

ok=0
for B in "\${BASES[@]}"; do
  register_runner "\${B}" "/api/llm-runner/agents/register" && ok=1 && break
done
set -e

if [[ \$ok -eq 1 ]]; then
  echo ">>> Done. Runner \"\${RUNNER_NAME}\" registered at \${RUNNER_URL}"
else
  echo ">>> WARNING: Registration failed against known endpoints."
  echo ">>> Try explicit HTTPS and token, e.g.:"
  echo "curl -k -H 'Authorization: Bearer \${REG_TOKEN}' -H 'Content-Type: application/json' \\\\"
  echo "  -d '{\"name\":\"\${RUNNER_NAME}\",\"url\":\"\${RUNNER_URL}\",\"token\":\"\${RUNNER_TOKEN}\",\"default_cwd\":\"\${BASE_DIR}\"}' \\\\"
  echo "  \"https://<edge>:8443/api/llm-runner/agents/register\""
fi
`);
}

function systemdScript(req, res) {
  const server = (req.query.server || process.env.PUBLIC_EDGE_BASE || 'http://localhost:8080').replace(/\/+$/, '');
  res.type('text/x-shellscript');
  res.send(`#!/usr/bin/env bash
set -euo pipefail

# This is a placeholder for a systemd installer; customize to your agent implementation.
echo "Systemd installer not implemented in MVP. Use Docker installer via ${server}/install/runner.sh"
`);
}

// ✅ Proper CommonJS exports:
module.exports = { dockerScript, systemdScript };
