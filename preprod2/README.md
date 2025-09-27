# Advanced Web IDE Pro

A web-based IDE with SSH terminal bridging, file explorer, Git helpers, Docker panel, and a simple GitHub integration helper.

## Table of Contents
- Overview
- Architecture
- Quick Start
- SSH Connection (Password vs Key)
- GitHub Repository Connection
- UI Tips and Tooltips
- Configuration
- Security Notes
- FAQ

## Overview
This project serves a static frontend (the IDE) and an optional backend SSH bridge that opens a shell on a remote server and streams it to the browser via WebSocket.

## Architecture
- Frontend (static): Served by any static server or via the provided Dockerfile (port 3020).
- Backend SSH Bridge (Node.js): Simple Express + WebSocket server using ssh2 to open a real shell on a remote host (port 3021).

Paths:
- Frontend: index.html, src/*
- SSH Bridge: backend/*

## Quick Start
1) Start SSH Bridge backend locally:
   - cd backend && npm i && npm run dev
   - It listens on http://localhost:3021

2) Open the IDE:
   - Serve preprod2/ with any static server (or use the provided Dockerfile at the project root which exposes 3020).
   - Open http://localhost:3020 in a browser.

3) Configure the backend URL (optional):
   - The IDE defaults to http://localhost:3021. You can override by setting window.__BACKEND_URL before src/main.js is loaded:
     <script>window.__BACKEND_URL = 'https://your-bridge.example.com';</script>

## SSH Connection (Password vs Key)
- Where do I put my password?
  - In the left sidebar, open the SSH tab (🔗). Change Authentication to "Password" and a Password field appears. Enter your password there, then click Connect.
- SSH key method:
  - With Authentication set to "SSH Key", paste your private key (PEM/OpenSSH) into the Private Key field. If your key has a passphrase, enter it in the Passphrase field.
- What happens to my credentials?
  - Passwords and keys are used in-memory in your browser tab and sent only to the local SSH bridge to establish the session. They are not stored or logged by the frontend. The backend also avoids logging secrets.
- Switching methods:
  - Changing the Authentication selector will show/hide the appropriate fields.

## GitHub Repository Connection
You have two recommended options:

1) Using SSH (recommended if you have keys on GitHub):
   - Ensure your public key is added to GitHub (Settings → SSH and GPG keys).
   - In the IDE, connect to your remote server via SSH.
   - In the terminal, run: git clone git@github.com:owner/repo.git

2) Using HTTPS + Personal Access Token (PAT):
   - Click the 🔗 button in the Repository sidebar to open the GitHub modal.
   - Paste your PAT (scopes: repo) and the repository URL (https://github.com/owner/repo.git).
   - Choose Clone (or Initialize & Connect, or Connect Existing).
   - The IDE will show a masked command and, if connected to SSH, run the real command in the remote terminal. Tokens are not stored and are masked in UI logs.

Notes:
- If you are not connected to SSH, the IDE will show the masked command so you can run it locally.
- For HTTPS, the IDE constructs an URL like: https://x-access-token:***@github.com/owner/repo.git and sends the unmasked form only to the shell over a local WS connection.

## UI Tips and Tooltips
- Hover over buttons to see usage hints (Save, Build, Pull, Connect SSH, etc.).
- In the SSH panel, you will see explanatory text beneath the credential fields.

## Configuration
- Backend URL: window.__BACKEND_URL (default http://localhost:3021)
- Backend port (bridge): env PORT (default 3021)

## Security Notes
- Credentials are never persisted client-side by this app.
- The backend avoids logging secrets (see comments in backend/server.js) but you should still run it on trusted infrastructure and secure the deployment (TLS/Reverse proxy, auth).
- When using HTTPS tokens for Git, the token is masked in the UI and only sent to the shell over a local WS connection.

## FAQ
Q: When trying to connect via password, I don't have to put my password anywhere?
A: You do. In the SSH panel, change Authentication to "Password" and the Password field appears. Enter it there. It is used only to establish the session and is not stored.

Q: How do I connect to a GitHub repository?
A: Either:
   - Use SSH URLs (git@github.com:owner/repo.git) if your SSH key is set up on GitHub, or
   - Use HTTPS with a PAT via the GitHub modal. The IDE builds the git command and, if connected to SSH, runs it remotely; the token is masked in logs and not stored.

Q: Can I use the IDE without the backend?
A: Yes, the UI will still load. The terminal then simulates outputs. For real remote shell IO, run the backend.

Q: How do I change the backend endpoint?
A: Set window.__BACKEND_URL before loading src/main.js.

Q: Are git actions real?
A: Git buttons in the sidebar print outputs to the terminal for now. Use the terminal for actual git commands (the GitHub modal helps you construct and run them).