#!/usr/bin/env bash
set -euo pipefail

# Small helper to resolve the OpenVSCode Server launcher.
# On this image, the 'openvscode-server' command bootstraps itself into ~/.openvscode-server
# on first run, so we prefer calling it by name rather than a hardcoded path.
ovscode() {
  if command -v openvscode-server >/dev/null 2>&1; then
    echo "openvscode-server"
  else
    # Fallback to the typical bootstrap install path (after first run)
    echo "${HOME}/.openvscode-server/bin/openvscode-server"
  fi
}

OVSCODE_BIN="$(ovscode)"

echo "Starting API server on port ${API_PORT:-3007} and OpenVSCode on port ${PORT:-3006}..."

# Start API server in the background if present
if [ -f "/home/openvscode-server/server/index.js" ]; then
  NODE_ENV="${NODE_ENV:-production}" \
  PORT="${API_PORT:-3007}" \
  node /home/openvscode-server/server/index.js &
else
  echo "Warning: /home/openvscode-server/server/index.js not found; skipping API server."
fi

# Ensure OpenVSCode Server is bootstrapped (first call will download to ~/.openvscode-server)
# Try a no-op command to trigger bootstrap quietly.
${OVSCODE_BIN} --help >/dev/null 2>&1 || true

# Install desired extensions at runtime (works both first run and subsequent runs)
EXTENSIONS=(
  ms-python.python
  ms-vscode.cpptools
  ms-azuretools.vscode-docker
  eamodio.gitlens
  esbenp.prettier-vscode
  dbaeumer.vscode-eslint
)

for ext in "${EXTENSIONS[@]}"; do
  echo "Installing extension: $ext"
  # Don't fail the container if one extension fails to install
  ${OVSCODE_BIN} --install-extension "$ext" || echo "Failed to install $ext (continuing)"
done

# Launch OpenVSCode Server in the foreground (PID 1)
exec ${OVSCODE_BIN} \
  --host 0.0.0.0 \
  --port "${PORT:-3006}" \
  --without-connection-token \
  --default-folder="${WORKSPACE_DIR:-/home/workspace}"
