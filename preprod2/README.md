# Advanced Web IDE Pro (Modular)

This is a modular, browser-only implementation of the original single-file IDE. It separates concerns across ES modules and CSS files, adds structured logging, and centralizes state management.

How to run:
- No build step required. Open index.html in a modern browser (served via a local web server for best results to avoid CORS on some browsers).
- Monaco Editor is loaded via CDN and AMD loader.

Key folders:
- assets/css: Base and IDE styles
- src/core: Logger, EventBus, State
- src/ui: DOM helpers, notifications, panels, fileTree, tabs, statusBar, modals
- src/editor: Monaco editor wiring
- src/terminal: Terminal utilities and dispatcher
- src/services: API simulations (SSH, Git, Docker, DB, Search)
- src/utils: Generic utilities (path, time)
- src/data: Sample local/remote file trees

Logging:
- Change window.__LOG_LEVEL to one of: debug, info, warn, error to control verbosity.

Notes:
- This UI uses in-memory file trees for demo purposes.
- All network/CLI operations are simulated. Replace services/api.js with real backends as needed.
