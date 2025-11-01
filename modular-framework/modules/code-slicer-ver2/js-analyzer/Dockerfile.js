# -------- slicer-js (Node/TypeScript) --------
FROM node:20-slim

# Install tini for proper signal handling
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates tini \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
RUN npm install --ignore-scripts

COPY tsconfig.json ./
COPY src ./src

RUN npm run build

# repo is mounted read-only at /repo, output at /out
VOLUME ["/repo", "/out"]

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/cli.js", "--repo", "/repo", "--out", "/out", "--profile"]
