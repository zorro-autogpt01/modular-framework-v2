# SSH Terminal Module

Provides REST and WebSocket APIs to establish SSH sessions, run an interactive shell, and perform basic SFTP operations.

Base path (behind edge): /api/ssh-terminal

Endpoints
- POST /ssh/connect
- GET  /ssh/list?sessionId=...&path=...&depth=...
- GET  /ssh/read?sessionId=...&path=...
- POST /ssh/write { sessionId, path, content }
- POST /ssh/mkdir { sessionId, path, recursive }
- POST /ssh/disconnect { sessionId }
- WS   /ssh?sessionId=...

WebSocket messages (client->server)
- { "type": "data", "data": "<string>" }  // data written to shell
- { "type": "resize", "cols": <int>, "rows": <int> } // resize PTY window

Notes
- Do not log secrets (passwords/private keys). This module avoids logging request bodies.
- Sessions are in-memory. For production multi-instance, use a shared store or sticky sessions.
