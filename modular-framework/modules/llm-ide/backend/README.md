# SSH Bridge Backend

Runs an HTTP API and a WebSocket bridge to forward terminal I/O to a real SSH shell.

## Run locally

```bash
cd backend
npm i
npm run dev
```

By default it listens on `http://localhost:3021` and `ws://localhost:3021/ssh`.

## API

* `POST /ssh/connect` → `{ ok, sessionId }`
* `POST /ssh/disconnect` → `{ ok }`
* `WS /ssh?sessionId=...` → raw bytes or JSON frames

  * Send `{ "type":"data", "data":"ls\n" }` to write to the shell
  * Send `{ "type":"resize", "cols":120, "rows":32 }` to resize the PTY

